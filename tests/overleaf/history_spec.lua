local history = require('overleaf.editor.history')

local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end

local function set(buf, value)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(value, '\n', { plain = true }))
  vim.bo[buf].undolevels = vim.bo[buf].undolevels
end

local function expect_error(code, fn)
  local ok, err = pcall(fn)
  assert.is_false(ok)
  assert.is_truthy(tostring(err):find(code, 1, true), tostring(err))
end

describe('native editor history', function()
  local buf, captures
  local base = 'intro\nseparator\nending'
  local edited = 'MY intro\nseparator\nending'

  before_each(function()
    captures = {}
    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_set_current_buf(buf)
    vim.bo[buf].undolevels = -1
    set(buf, base)
    vim.bo[buf].undolevels = 1000
    vim.bo[buf].modified = false
  end)

  after_each(function()
    for _, capture in ipairs(captures) do
      history.dispose(capture)
    end
    if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
  end)

  local function capture()
    local result = history.capture(buf)
    table.insert(captures, result)
    return result
  end

  -- This fixture is the clean rebase supplied by Node. Node tests exercise Git;
  -- these tests exercise actual native history installation and traversal.
  local function incoming(snapshot)
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = node.content:gsub('ending', 'THEIR ending')
    end
    return result
  end

  it('captures local undo units without changing the visible buffer or native history', function()
    set(buf, edited)
    local before = vim.fn.undotree()
    local tick = vim.api.nvim_buf_get_changedtick(buf)
    local snapshot = capture()
    assert.are.equal(edited, text(buf))
    assert.are.equal(tick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.same(before, vim.fn.undotree())
    assert.are.equal(2, #snapshot.history.nodes)
    assert.are.equal(base, snapshot.history.nodes[1].content)
    assert.are.equal(edited, snapshot.history.nodes[2].content)
  end)

  it('native undo and redo preserve incoming text, including repeated undo', function()
    set(buf, edited)
    local snapshot = capture()
    history.install(snapshot, incoming(snapshot), true)
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent normal! u')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent normal! u')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent redo')
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('keeps real undo grouping rather than splitting every text notification', function()
    set(buf, 'M intro\nseparator\nending')
    vim.cmd('undojoin')
    set(buf, edited)
    local snapshot = capture()
    assert.are.equal(2, #snapshot.history.nodes)
    history.install(snapshot, incoming(snapshot), true)
    vim.cmd('silent undo')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('retains redo when an update arrives at an undone state', function()
    set(buf, edited)
    vim.cmd('silent undo')
    local snapshot = capture()
    history.install(snapshot, incoming(snapshot), false)
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent redo')
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('keeps alternate branches and supports native sequence and time traversal', function()
    set(buf, edited)
    local first = vim.fn.undotree().seq_cur
    set(buf, 'SECOND intro\nseparator\nending')
    local second = vim.fn.undotree().seq_cur
    vim.cmd('silent undo ' .. first)
    set(buf, 'ALTERNATE intro\nseparator\nending')
    local alternate = vim.fn.undotree().seq_cur
    vim.cmd('silent undo ' .. second)
    local snapshot = capture()
    local sequences = history.install(snapshot, incoming(snapshot), true)
    assert.are.equal('SECOND intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent undo ' .. sequences[alternate])
    assert.are.equal('ALTERNATE intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent earlier 1')
    assert.are.equal('SECOND intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent later 1')
    assert.are.equal('ALTERNATE intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent normal! 2u')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('updates an untouched buffer without adding an incoming undo entry', function()
    local snapshot = capture()
    history.install(snapshot, incoming(snapshot), false)
    vim.cmd('silent undo')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
    assert.are.equal(0, #vim.fn.undotree().entries)
  end)

  it('rejects a delayed update after local typing without changing text or history', function()
    set(buf, edited)
    local snapshot = capture()
    set(buf, 'new local work')
    local before = vim.fn.undotree()
    expect_error('STALE_BUFFER', function() history.install(snapshot, incoming(snapshot), true) end)
    assert.are.equal('new local work', text(buf))
    assert.are.same(before, vim.fn.undotree())
  end)

  it('rejects a delayed update after native history navigation', function()
    set(buf, edited)
    local snapshot = capture()
    vim.cmd('silent undo')
    expect_error('STALE_BUFFER', function() history.install(snapshot, incoming(snapshot), true) end)
    assert.are.equal(base, text(buf))
  end)

  it('rejects incomplete history before replacing the buffer', function()
    set(buf, edited)
    local snapshot = capture()
    local malformed = incoming(snapshot)
    table.remove(malformed.nodes, 1)
    expect_error('INVALID_HISTORY', function() history.install(snapshot, malformed, true) end)
    assert.are.equal(edited, text(buf))
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
  end)

  it('preserves Unicode, empty final lines, editor options, and the requested modified flag', function()
    set(buf, '😀 日本語\nseparator\nending\n')
    vim.bo[buf].endofline = false
    vim.bo[buf].fixendofline = false
    vim.bo[buf].fileformat = 'dos'
    local snapshot = capture()
    history.install(snapshot, incoming(snapshot), false)
    assert.are.equal('😀 日本語\nseparator\nTHEIR ending\n', text(buf))
    assert.is_false(vim.bo[buf].modified)
    assert.is_false(vim.bo[buf].endofline)
    assert.is_false(vim.bo[buf].fixendofline)
    assert.are.equal('dos', vim.bo[buf].fileformat)
  end)

  it('a second incoming update preserves the same local undo units', function()
    set(buf, edited)
    local first = capture()
    history.install(first, incoming(first), true)
    local second = capture()
    history.install(second, incoming(second), true)
    vim.cmd('silent undo')
    assert.are.equal('intro\nseparator\nTHEIR THEIR ending', text(buf))
    vim.cmd('silent redo')
    assert.are.equal('MY intro\nseparator\nTHEIR THEIR ending', text(buf))
  end)

  it('disposes temporary recovery files and rejects reusing a disposed capture', function()
    set(buf, edited)
    local snapshot = capture()
    local directory = snapshot.directory
    assert.are.equal(1, vim.fn.isdirectory(directory))
    history.dispose(snapshot)
    assert.are.equal(0, vim.fn.isdirectory(directory))
    expect_error('HISTORY_DISPOSED', function() history.install(snapshot, incoming(snapshot), true) end)
  end)

  it('consumes already reverted text once without duplicating it on redo', function()
    set(buf, edited)
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = base
    end
    history.install(snapshot, result, false)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    vim.cmd('silent redo')
    assert.are.equal(base, text(buf))
  end)

  it('captures and rebases the reachable history after native pruning', function()
    vim.bo[buf].undolevels = 2
    for i = 1, 6 do
      set(buf, i .. ' intro\nseparator\nending')
    end
    local snapshot = capture()
    local sequences = history.install(snapshot, incoming(snapshot), true)
    assert.are.same(snapshot.tree, vim.fn.undotree())
    for _, node in ipairs(snapshot.history.nodes) do
      assert.are.equal(node.seq, sequences[node.seq])
    end
    vim.cmd('silent earlier 100')
    assert.is_truthy(text(buf):find('THEIR ending', 1, true))
    vim.cmd('silent later 100')
    assert.are.equal('6 intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('preserves cursor, scroll position, and unrelated extmarks when lines are inserted', function()
    set(buf, edited)
    vim.api.nvim_win_set_cursor(0, { 3, 2 })
    local namespace = vim.api.nvim_create_namespace('overleaf-history-test')
    local mark = vim.api.nvim_buf_set_extmark(buf, namespace, 2, 1, {})
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = 'incoming line\n' .. node.content
    end
    history.install(snapshot, result, true)
    assert.are.same({ 4, 2 }, vim.api.nvim_win_get_cursor(0))
    assert.are.same({ 3, 1 }, vim.api.nvim_buf_get_extmark_by_id(buf, namespace, mark, {}))
  end)

  it('restores text and the original undo tree if importing the candidate fails', function()
    set(buf, edited)
    local snapshot = capture()
    local original_cmd = vim.cmd
    vim.cmd = function(cmd)
      if
        vim.api.nvim_get_current_buf() == buf
        and cmd:find('rundo', 1, true)
        and cmd:find('candidate.undo', 1, true)
      then
        error('injected import failure')
      end
      return original_cmd(cmd)
    end
    local ok, err = pcall(history.install, snapshot, incoming(snapshot), true)
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('injected import failure', 1, true))
    assert.are.equal(edited, text(buf))
    assert.are.same(snapshot.tree, vim.fn.undotree())
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
  end)

  it('rebases captured history through the bridge and installs it for native undo', function()
    set(buf, edited)
    local snapshot = capture()
    local bridge = require('overleaf.bridge')
    local finished, failure, result = false, nil, nil
    bridge.start(function(start_error)
      if start_error then
        failure, finished = start_error, true
        return
      end
      bridge.request('rebaseEditorHistory', {
        history = snapshot.history,
        content = 'MY intro\nseparator\nTHEIR ending',
      }, function(err, response)
        failure, result, finished = err, response, true
      end)
    end)
    local completed = vim.wait(5000, function() return finished end)
    bridge.stop()
    vim.wait(1500, function() return not bridge.is_running() end)
    assert.is_true(completed)
    assert.is_nil(failure)
    assert.are.equal('clean', result.status)
    history.install(snapshot, result.history, true)
    vim.cmd('silent undo')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent redo')
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('holds excessive history before touching the buffer', function()
    vim.bo[buf].undolevels = 1100
    for i = 1, 1000 do
      set(buf, tostring(i))
    end
    local before = vim.fn.undotree()
    expect_error('HISTORY_LIMIT', capture)
    assert.are.equal('1000', text(buf))
    assert.are.same(before, vim.fn.undotree())
  end)

  it('keeps recovery text and native history if both installation and rollback import fail', function()
    set(buf, edited)
    local snapshot = capture()
    local original_cmd = vim.cmd
    vim.cmd = function(cmd)
      if vim.api.nvim_get_current_buf() == buf and cmd:find('rundo', 1, true) then
        error('injected disk read failure')
      end
      return original_cmd(cmd)
    end
    local ok, err = pcall(history.install, snapshot, incoming(snapshot), true)
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('HISTORY_RECOVERY_REQUIRED', 1, true))
    assert.is_truthy(tostring(err):find(snapshot.directory, 1, true))
    assert.are.equal(edited, text(buf))
    history.dispose(snapshot)
    assert.are.equal(1, vim.fn.filereadable(snapshot.directory .. '/original.undo'))
    local backup = vim.json.decode(table.concat(vim.fn.readfile(snapshot.directory .. '/snapshot.json'), '\n'))
    assert.are.equal(edited, backup.content)
    assert.are.equal(base, backup.history.nodes[1].content)
    -- This is a disposable test buffer, so remove the deliberately retained backup.
    vim.fn.delete(snapshot.directory, 'rf')
  end)

  it('keeps native insert-mode undo boundaries and line undo local', function()
    local keys = vim.api.nvim_replace_termcodes('gg0iMY <C-g>uNEW <Esc>', true, false, true)
    vim.api.nvim_feedkeys(keys, 'xt', false)
    local snapshot = capture()
    assert.are.equal(3, #snapshot.history.nodes)
    history.install(snapshot, incoming(snapshot), true)
    vim.cmd('silent undo')
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent undo')
    assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent normal! 3GU')
    assert.is_truthy(text(buf):find('THEIR ending', 1, true))
  end)

  it('verifies rollback even when native undo import silently rejects its file', function()
    set(buf, edited)
    local snapshot = capture()
    local original_cmd = vim.cmd
    vim.cmd = function(cmd)
      if vim.api.nvim_get_current_buf() == buf and cmd:find('rundo', 1, true) then return end
      return original_cmd(cmd)
    end
    local ok, err = pcall(history.install, snapshot, incoming(snapshot), true)
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('HISTORY_RECOVERY_REQUIRED', 1, true))
    history.dispose(snapshot)
    assert.are.equal(1, vim.fn.filereadable(snapshot.directory .. '/original.undo'))
    vim.fn.delete(snapshot.directory, 'rf')
  end)

  it('preserves sequence IDs and timestamps for time-based native undo', function()
    set(buf, edited)
    vim.wait(1100, function() return false end)
    set(buf, 'SECOND intro\nseparator\nending')
    local snapshot = capture()
    vim.wait(1100, function() return false end)
    history.install(snapshot, incoming(snapshot), true)
    assert.are.same(snapshot.tree, vim.fn.undotree())
    vim.cmd('silent earlier 1s')
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('preserves save markers for file-write-based undo and redo', function()
    local filename = vim.fn.tempname()
    vim.bo[buf].buftype = ''
    vim.api.nvim_buf_set_name(buf, filename)
    set(buf, edited)
    vim.cmd('silent noautocmd write')
    set(buf, 'SECOND intro\nseparator\nending')
    vim.cmd('silent noautocmd write')
    set(buf, 'UNSAVED intro\nseparator\nending')
    local snapshot = capture()
    vim.fn.delete(filename)
    history.install(snapshot, incoming(snapshot), true)
    assert.are.same(snapshot.tree, vim.fn.undotree())
    vim.cmd('silent earlier 1f')
    assert.are.equal('SECOND intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent earlier 1f')
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent later 1f')
    assert.are.equal('SECOND intro\nseparator\nTHEIR ending', text(buf))
  end)

  it('holds an update at an unsupported saved undo state and can retry after a normal save', function()
    local filename = vim.fn.tempname()
    vim.bo[buf].buftype = ''
    vim.api.nvim_buf_set_name(buf, filename)
    set(buf, edited)
    vim.cmd('silent noautocmd write')
    set(buf, 'SECOND intro\nseparator\nending')
    vim.cmd('silent noautocmd write')
    set(buf, 'THIRD intro\nseparator\nending')
    vim.cmd('silent noautocmd write')
    vim.cmd('silent earlier 2f')
    local snapshot = capture()
    local tick = vim.api.nvim_buf_get_changedtick(buf)
    expect_error('HISTORY_HELD', function() history.install(snapshot, incoming(snapshot), true) end)
    assert.are.equal(tick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.equal(edited, text(buf))
    assert.are.same(snapshot.tree, vim.fn.undotree())
    -- A normal save makes the native current/last save counters agree. Retry
    -- from a fresh capture, since both the buffer and its history may evolve.
    vim.cmd('silent noautocmd write')
    local retry = capture()
    history.install(retry, incoming(retry), true)
    assert.are.same(retry.tree, vim.fn.undotree())
    assert.are.equal('MY intro\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent later 1f')
    assert.are.equal('THIRD intro\nseparator\nTHEIR ending', text(buf))
    vim.fn.delete(filename)
  end)

  it('holds a candidate rejected in the scratch buffer before changing the source', function()
    set(buf, edited)
    local snapshot = capture()
    local original_cmd = vim.cmd
    vim.cmd = function(cmd)
      if cmd:find('rundo', 1, true) and cmd:find('candidate.undo', 1, true) then return end
      return original_cmd(cmd)
    end
    -- Force generated timestamps to differ, so a skipped import is observable.
    vim.wait(1100, function() return false end)
    local ok, err = pcall(history.install, snapshot, incoming(snapshot), true)
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('HISTORY_HELD', 1, true), tostring(err))
    assert.are.equal(snapshot.changedtick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.equal(edited, text(buf))
    assert.are.same(snapshot.tree, vim.fn.undotree())
  end)

  it('holds an unsaved alternate branch without changing time-based undo', function()
    local filename = vim.fn.tempname()
    vim.bo[buf].buftype = ''
    vim.api.nvim_buf_set_name(buf, filename)
    set(buf, edited)
    vim.cmd('silent noautocmd write')
    set(buf, 'SECOND intro\nseparator\nending')
    vim.cmd('silent noautocmd write')
    vim.cmd('silent undo 1')
    vim.wait(2100, function() return false end)
    set(buf, 'ALTERNATE intro\nseparator\nending')
    local snapshot = capture()
    expect_error('HISTORY_HELD', function() history.install(snapshot, incoming(snapshot), true) end)
    assert.are.equal(snapshot.changedtick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.same(snapshot.tree, vim.fn.undotree())
    vim.cmd('silent earlier 1s')
    assert.are.equal(edited, text(buf))
    vim.fn.delete(filename)
  end)

  it('round-trips metadata without changing native text or extmark records', function()
    set(buf, edited)
    vim.cmd('silent 1move 3')
    local snapshot = capture()
    local file = assert(io.open(snapshot.original, 'rb'))
    local bytes = file:read('*a')
    file:close()
    local sequences = {}
    for _, node in ipairs(snapshot.history.nodes) do
      sequences[node.seq] = node.seq
    end
    local undofile = require('overleaf.editor.undofile')
    assert.are.equal(bytes, undofile.restore(bytes, bytes, sequences))
  end)

  it('exports a detached JSON checkpoint with native recovery bytes and editor options', function()
    local empty = capture()
    assert.are.equal(vim.NIL, history.checkpoint(empty).undo)
    set(buf, edited)
    local snapshot = capture()
    local checkpoint = vim.json.decode(vim.json.encode(history.checkpoint(snapshot)))
    assert.are.same(snapshot.history, checkpoint.history)
    assert.are.same(snapshot.tree, checkpoint.tree)
    assert.are.same(snapshot.options, checkpoint.options)
    assert.is_nil(checkpoint.directory)
    local file = assert(io.open(snapshot.original, 'rb'))
    assert.are.equal(file:read('*a'), vim.base64.decode(checkpoint.undo))
    file:close()
    checkpoint.history.nodes[1].content = 'caller mutation'
    assert.are.equal(base, snapshot.history.nodes[1].content)
    set(buf, 'later typing')
    expect_error('STALE_BUFFER', function() history.checkpoint(snapshot) end)
  end)

  it('captures native empty-buffer flags separately from blank lines and BOM options', function()
    vim.bo[buf].undolevels = -1
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
    vim.bo[buf].undolevels = 1000
    vim.bo[buf].bomb = true
    local empty = capture()
    assert.is_true(empty.empty)
    assert.is_true(empty.history.nodes[1].empty)
    assert.is_true(history.checkpoint(empty).options.bomb)
    set(buf, '')
    local blank = capture()
    assert.is_false(blank.empty)
    assert.is_true(blank.history.nodes[1].empty)
    assert.is_false(blank.history.nodes[2].empty)
    history.install(blank, blank.history, true)
    assert.are.equal(1, vim.fn.wordcount().chars)
    vim.cmd('silent undo')
    assert.are.equal(0, vim.fn.wordcount().chars)
    vim.cmd('silent redo')
    assert.are.equal(1, vim.fn.wordcount().chars)
  end)

  it('rejects truncated, unknown, and mismatched undo files before native import', function()
    set(buf, edited)
    local snapshot = capture()
    local file = assert(io.open(snapshot.original, 'rb'))
    local bytes = file:read('*a')
    file:close()
    local undofile = require('overleaf.editor.undofile')
    for length = 0, #bytes - 1 do
      expect_error('HISTORY_HELD', function() undofile.restore(bytes, bytes:sub(1, length), { [0] = 0, [1] = 1 }) end)
    end
    for _, invalid in ipairs({ 'INVALID' .. bytes, bytes:sub(1, 9) .. '\0\4' .. bytes:sub(12), bytes .. 'trailing' }) do
      expect_error('HISTORY_HELD', function() undofile.restore(bytes, invalid, { [0] = 0, [1] = 1 }) end)
    end
    expect_error('HISTORY_HELD', function() undofile.restore(bytes, bytes, { [0] = 0, [1] = 2 }) end)
    expect_error('HISTORY_HELD', function() undofile.restore(bytes, bytes, { [0] = 0, [1] = 1, [2] = 1 }) end)
  end)
end)
