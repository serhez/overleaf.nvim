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

local function read(path)
  local file = assert(io.open(path, 'rb'))
  local bytes = file:read('*a')
  assert(file:close())
  return bytes
end

local function write(path, bytes)
  local file = assert(io.open(path, 'wb'))
  assert(file:write(bytes))
  assert(file:close())
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

  it('restores an archived native checkpoint across restart without losing branches or save markers', function()
    set(buf, edited)
    set(buf, 'alternate')
    vim.cmd('silent undo')
    set(buf, 'UNSAVED ' .. edited)
    local archived = history.checkpoint(capture())
    vim.api.nvim_buf_delete(buf, { force = true })
    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_set_current_buf(buf)
    vim.bo[buf].undolevels = -1
    set(buf, base)
    vim.bo[buf].undolevels = 1000
    local before = capture()
    history.restore(before, archived, true)
    assert.are.equal('UNSAVED ' .. edited, text(buf))
    local restored = capture()
    assert.are.same(archived.history, restored.history)
    assert.are.equal(archived.tree.save_last, restored.tree.save_last)
    vim.cmd('silent undo 2')
    assert.are.equal('alternate', text(buf))
    vim.cmd('silent undo ' .. archived.history.current)
    assert.are.equal('UNSAVED ' .. edited, text(buf))
  end)

  it('refuses stale or malformed recovery checkpoints without changing live text or history', function()
    set(buf, edited)
    local archived = history.checkpoint(capture())
    set(buf, 'current live text')
    local before = capture()
    local wrong = vim.deepcopy(archived)
    wrong.history.nodes[1].content = 'mismatched history'
    expect_error('HISTORY_HELD', function() history.restore(before, wrong, true) end)
    assert.are.equal('current live text', text(buf))
    assert.are.same(before.tree, vim.fn.undotree())
    local wrong_metadata = vim.deepcopy(archived)
    wrong_metadata.tree.entries[1].time = wrong_metadata.tree.entries[1].time + 1
    expect_error('HISTORY_HELD', function() history.restore(before, wrong_metadata, true) end)
    assert.are.equal('current live text', text(buf))
    set(buf, 'newer live text')
    expect_error('STALE_BUFFER', function() history.restore(before, archived, true) end)
    assert.are.equal('newer live text', text(buf))
  end)

  it('rolls back a rejected live recovery import and keeps the archived checkpoint unchanged', function()
    set(buf, edited)
    local archived = history.checkpoint(capture())
    set(buf, 'current live text')
    local before = capture()
    local command = vim.cmd
    vim.cmd = function(cmd)
      if vim.api.nvim_get_current_buf() == buf and cmd:find('recovery.undo', 1, true) then
        error('injected recovery import failure')
      end
      return command(cmd)
    end
    local ok, err = pcall(history.restore, before, archived, true)
    vim.cmd = command
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('injected', 1, true))
    assert.are.equal('current live text', text(buf))
    assert.are.same(before.tree, vim.fn.undotree())
    assert.are.equal(edited, archived.history.nodes[2].content)
  end)

  it('rebases saved persistent history independently of a joined unsaved live edit', function()
    vim.bo[buf].buftype = ''
    set(buf, edited)
    local saved = capture()
    local checkpoint = history.checkpoint(saved)
    local bytes = vim.base64.encode(history.saved_undo(saved, true))
    vim.cmd('undojoin')
    set(buf, 'UNSAVED intro\nseparator\nending')
    local live = capture()
    assert.are.equal(2, #live.history.nodes)
    assert.are_not.equal(edited, live.history.nodes[2].content)
    local result = history.rebase_saved(checkpoint, bytes, incoming(saved))
    assert.are.same(incoming(saved), result.checkpoint.history)
    assert.are.equal(1, result.checkpoint.tree.save_last)
    assert.are.equal(result.bytes, result.checkpoint.undo)
    assert.are.same(live.tree, vim.fn.undotree())
    assert.are.equal(live.changedtick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.equal(live.content, text(buf))
    assert.is_true(vim.bo[buf].modified)
    local filename = saved.directory .. '/reopen.tex'
    write(filename, edited:gsub('ending', 'THEIR ending'))
    write(saved.directory .. '/.reopen.tex.un~', vim.base64.decode(result.bytes))
    local undodir, undofile = vim.o.undodir, vim.go.undofile
    local reopened
    local ok, err = pcall(function()
      vim.o.undodir, vim.go.undofile = '.', true
      reopened = vim.fn.bufadd(filename)
      vim.fn.bufload(reopened)
      vim.api.nvim_buf_call(reopened, function()
        assert.are.equal(1, vim.fn.undotree().save_last)
        vim.cmd('silent undo')
        assert.are.equal(base:gsub('ending', 'THEIR ending'), text(reopened))
        assert.is_true(vim.bo[reopened].modified)
        vim.cmd('silent redo')
        assert.are.equal(edited:gsub('ending', 'THEIR ending'), text(reopened))
        assert.is_false(vim.bo[reopened].modified)
      end)
    end)
    vim.o.undodir, vim.go.undofile = undodir, undofile
    if reopened then vim.api.nvim_buf_delete(reopened, { force = true }) end
    assert.is_true(ok, tostring(err))
  end)

  it('rebases an archive with no undo states without inventing local edits or save markers', function()
    local saved = capture()
    local result = history.rebase_saved(history.checkpoint(saved), vim.NIL, incoming(saved))
    assert.are.same(incoming(saved), result.checkpoint.history)
    assert.are.equal(0, result.checkpoint.tree.save_last)
    assert.are.equal(vim.NIL, result.bytes)
    assert.are.same(saved.tree, vim.fn.undotree())
    assert.are.equal(base, text(buf))
  end)

  it('refuses a persisted native tree that differs from the recorded saved history', function()
    set(buf, edited)
    local saved = capture()
    local bytes = vim.base64.encode(history.saved_undo(saved, true))
    local checkpoint = history.checkpoint(saved)
    checkpoint.history.nodes[1].content = 'wrong original'
    expect_error('HISTORY_HELD', function() history.rebase_saved(checkpoint, bytes, incoming(saved)) end)
    assert.are.same(saved.tree, vim.fn.undotree())
    assert.are.equal(edited, text(buf))
  end)

  it('holds malformed archived bytes before importing them and preserves the live buffer', function()
    set(buf, edited)
    local saved = capture()
    local checkpoint = history.checkpoint(saved)
    local bytes = history.saved_undo(saved, true)
    for _, encoded in ipairs({
      'invalid base64!',
      vim.base64.encode(bytes:sub(1, -2)),
      vim.base64.encode(bytes:sub(1, 9) .. '\0\4' .. bytes:sub(12)),
    }) do
      expect_error('HISTORY_HELD', function() history.rebase_saved(checkpoint, encoded, incoming(saved)) end)
      assert.are.same(saved.tree, vim.fn.undotree())
      assert.are.equal(edited, text(buf))
    end
  end)

  for _, position in ipairs({ 'tip', 'root', 'branch', 'earlier-save' }) do
    it('exports the frozen ' .. position .. ' history exactly as native save completion does', function()
      set(buf, edited)
      local directory = capture().directory
      vim.bo[buf].buftype = ''
      vim.api.nvim_buf_set_name(buf, directory .. '/source.tex')
      vim.cmd('silent noautocmd write')
      set(buf, 'second edit')
      if position == 'root' then
        vim.cmd('silent undo 0')
      elseif position == 'branch' then
        vim.cmd('silent undo 1')
        set(buf, 'alternate branch')
      elseif position == 'earlier-save' then
        vim.cmd('silent noautocmd write')
        vim.cmd('silent earlier 1f')
      end
      local frozen = capture()
      local original = read(frozen.original)
      vim.cmd('silent noautocmd write')
      local native = directory .. '/native.undo'
      vim.cmd('silent noautocmd wundo ' .. vim.fn.fnameescape(native))
      set(buf, 'newer unsaved text')
      local before, tick = vim.fn.undotree(), vim.api.nvim_buf_get_changedtick(buf)
      local bytes = history.saved_undo(frozen, true)
      assert.are.equal(read(native), bytes)
      assert.are.equal(original, read(frozen.original))
      assert.are.equal('newer unsaved text', text(buf))
      assert.are.equal(tick, vim.api.nvim_buf_get_changedtick(buf))
      assert.are.same(before, vim.fn.undotree())
      assert.is_true(vim.bo[buf].modified)
    end)
  end

  it('does not duplicate a save marker when exporting an already finalized or clean save', function()
    set(buf, edited)
    local directory = capture().directory
    vim.bo[buf].buftype = ''
    vim.api.nvim_buf_set_name(buf, directory .. '/source.tex')
    vim.cmd('silent noautocmd write')
    local saved = capture()
    local bytes = history.saved_undo(saved, false)
    assert.are.equal(read(saved.original), bytes)
    assert.are.equal(bytes, history.saved_undo(saved, false))
    assert.are.same(saved.tree, vim.fn.undotree())
  end)

  for _, options in ipairs({
    { fileformat = 'unix', endofline = false, fixendofline = false, bomb = false },
    { fileformat = 'unix', endofline = false, fixendofline = true, bomb = false },
    { fileformat = 'dos', endofline = true, fixendofline = false, bomb = true },
  }) do
    it('reopens a saved file with its persistent local-only undo and redo: ' .. vim.inspect(options), function()
      for name, value in pairs(options) do
        vim.bo[buf][name] = value
      end
      set(buf, edited)
      local initial = capture()
      history.install(initial, incoming(initial), true)
      local frozen = capture()
      local filename = frozen.directory .. '/source.tex'
      vim.bo[buf].buftype = ''
      vim.api.nvim_buf_set_name(buf, filename)
      vim.cmd('silent noautocmd write')
      set(buf, 'newer unsaved text')
      local bytes = history.saved_undo(frozen, true)
      local saved_undodir, saved_undofile = vim.o.undodir, vim.go.undofile
      local ok, err = pcall(function()
        vim.o.undodir, vim.go.undofile = '.', true
        write(vim.fn.undofile(filename), bytes)
        vim.api.nvim_buf_delete(buf, { force = true })
        vim.cmd('silent noautocmd edit ' .. vim.fn.fnameescape(filename))
        buf = vim.api.nvim_get_current_buf()
        assert.are.equal(edited:gsub('ending', 'THEIR ending'), text(buf))
        assert.are.equal(frozen.tree.seq_cur, vim.fn.undotree().seq_cur)
        assert.are.equal(frozen.tree.save_last + 1, vim.fn.undotree().save_last)
        assert.is_false(vim.bo[buf].modified)
        vim.cmd('silent undo')
        assert.are.equal(base:gsub('ending', 'THEIR ending'), text(buf))
        assert.is_true(vim.bo[buf].modified)
        vim.cmd('silent redo')
        assert.are.equal(edited:gsub('ending', 'THEIR ending'), text(buf))
        assert.is_false(vim.bo[buf].modified)
      end)
      vim.o.undodir, vim.go.undofile = saved_undodir, saved_undofile
      assert.is_true(ok, tostring(err))
    end)
  end

  for _, case in ipairs({
    { content = 'first\n', normalized = 'first', fileformat = 'unix', bomb = false },
    { content = 'first\n\n', normalized = 'first\n', fileformat = 'dos', bomb = true },
    { content = '\n', normalized = '', fileformat = 'unix', bomb = true },
    { content = '', normalized = '', fileformat = 'unix', bomb = false, empty = true },
  }) do
    it('exports reloadable undo without changing ambiguous saved bytes: ' .. vim.inspect(case), function()
      vim.bo[buf].endofline, vim.bo[buf].fixendofline = false, false
      vim.bo[buf].fileformat, vim.bo[buf].bomb = case.fileformat, case.bomb
      set(buf, edited)
      set(buf, 'alternate')
      vim.cmd('silent undo')
      set(buf, case.content)
      local frozen = capture()
      local filename = frozen.directory .. '/source.tex'
      vim.bo[buf].buftype = ''
      vim.api.nvim_buf_set_name(buf, filename)
      vim.cmd('silent noautocmd write')
      local source = read(filename)
      set(buf, 'newer unsaved text')
      local live = capture()
      local artifact = history.saved_artifact(frozen, true)
      assert.are.equal(case.normalized, artifact.checkpoint.history.nodes[#frozen.history.nodes].content)
      assert.are.equal(case.empty or false, artifact.checkpoint.history.nodes[#frozen.history.nodes].empty)
      if not case.empty then assert.are.equal(artifact.bytes, artifact.checkpoint.undo) end
      assert.are.equal(live.content, text(buf))
      assert.are.same(live.tree, vim.fn.undotree())
      assert.are.equal(live.changedtick, vim.api.nvim_buf_get_changedtick(buf))
      assert.are.equal(source, read(filename))
      write(frozen.directory .. '/.source.tex.un~', vim.base64.decode(artifact.bytes))
      local undodir, undofile = vim.o.undodir, vim.go.undofile
      local reopened
      local ok, err = pcall(function()
        vim.o.undodir, vim.go.undofile = '.', true
        vim.api.nvim_buf_delete(buf, { force = true })
        reopened = vim.fn.bufadd(filename)
        vim.fn.bufload(reopened)
        vim.api.nvim_buf_call(reopened, function()
          assert.are.equal(frozen.tree.seq_cur, vim.fn.undotree().seq_cur)
          assert.are.equal(frozen.tree.save_last + 1, vim.fn.undotree().save_last)
          assert.are.equal(case.normalized, text(reopened))
          vim.cmd('silent undo')
          assert.are.equal(edited, text(reopened))
          vim.cmd('silent redo')
          assert.are.equal(case.normalized, text(reopened))
          assert.is_false(vim.bo[reopened].modified)
          vim.cmd('silent undo 2')
          assert.are.equal('alternate', text(reopened))
          vim.cmd('silent undo ' .. frozen.tree.seq_cur)
          assert.are.equal(case.normalized, text(reopened))
        end)
      end)
      vim.o.undodir, vim.go.undofile = undodir, undofile
      if reopened then vim.api.nvim_buf_delete(reopened, { force = true }) end
      assert.is_true(ok, tostring(err))
    end)
  end

  it('exports no undo file when the saved capture has no undo history', function()
    local frozen = capture()
    set(buf, 'later changes do not belong in the saved history')
    assert.is_nil(history.saved_undo(frozen, true))
    assert.is_nil(history.saved_undo(frozen, false))
  end)

  for _, empty in ipairs({ true, false }) do
    it('exports native saved undo for an ' .. (empty and 'empty buffer' or 'empty line'), function()
      set(buf, edited)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, empty and {} or { '' })
      vim.bo[buf].undolevels = vim.bo[buf].undolevels
      local frozen = capture()
      assert.are.equal(empty, frozen.empty)
      vim.bo[buf].buftype = ''
      vim.api.nvim_buf_set_name(buf, frozen.directory .. '/source.tex')
      vim.cmd('silent noautocmd write')
      local native = frozen.directory .. '/native.undo'
      vim.cmd('silent noautocmd wundo ' .. vim.fn.fnameescape(native))
      assert.are.equal(read(native), history.saved_undo(frozen, true))
    end)
  end

  it('exports the frozen save even after its live buffer has been unloaded', function()
    set(buf, edited)
    local frozen = capture()
    local expected = history.saved_undo(frozen, true)
    vim.api.nvim_buf_delete(buf, { force = true })
    assert.are.equal(expected, history.saved_undo(frozen, true))
  end)

  it('refuses an export silently rejected by native import and preserves its recovery copy', function()
    set(buf, edited)
    local frozen = capture()
    local original, command = read(frozen.original), vim.cmd
    vim.cmd = function(cmd)
      if cmd:find('rundo', 1, true) and cmd:find('persistent.undo', 1, true) then return end
      return command(cmd)
    end
    local ok, err = pcall(history.saved_undo, frozen, true)
    vim.cmd = command
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('HISTORY_HELD', 1, true), tostring(err))
    assert.are.equal(original, read(frozen.original))
    assert.are.same(frozen.tree, vim.fn.undotree())
    assert.are.equal(edited, text(buf))
  end)

  it('rejects undo bytes belonging to different text even when their metadata is valid', function()
    set(buf, edited)
    local frozen = capture()
    set(buf, 'different source text')
    local other = capture()
    write(frozen.original, read(other.original))
    expect_error('HISTORY_HELD', function() history.saved_undo(frozen, true) end)
    assert.are.same(other.tree, vim.fn.undotree())
    assert.are.equal(other.content, text(buf))
  end)

  it('rejects disposed captures and requires an explicit save-marker decision', function()
    set(buf, edited)
    local frozen = capture()
    expect_error('INVALID_HISTORY', function() history.saved_undo(frozen) end)
    history.dispose(frozen)
    expect_error('HISTORY_DISPOSED', function() history.saved_undo(frozen, true) end)
  end)

  it('rejects a corrupted frozen undo file without changing live history or the recovery copy', function()
    set(buf, edited)
    local frozen = capture()
    local bytes = read(frozen.original):sub(1, -2)
    write(frozen.original, bytes)
    expect_error('HISTORY_HELD', function() history.saved_undo(frozen, true) end)
    assert.are.equal(bytes, read(frozen.original))
    assert.are.same(frozen.tree, vim.fn.undotree())
    assert.are.equal(edited, text(buf))
  end)

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

  it('records a confirmed save in an ancestor without changing text, positions, or other history metadata', function()
    set(buf, edited)
    local written = capture()
    set(buf, 'LATER intro\nseparator\nending')
    vim.api.nvim_buf_set_mark(buf, 'a', 2, 2, {})
    local ns = vim.api.nvim_create_namespace('saved-marker')
    local mark = vim.api.nvim_buf_set_extmark(buf, ns, 1, 2, {})
    local current = capture()
    local expected = vim.deepcopy(current.tree)
    expected.save_cur, expected.save_last = 1, 1
    expected.entries[1].save = 1
    local tick = vim.api.nvim_buf_get_changedtick(buf)
    local view = vim.fn.winsaveview()
    history.record_save(current, written)
    assert.are.same(expected, vim.fn.undotree())
    assert.are.equal(current.content, text(buf))
    assert.are.equal(tick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.same(view, vim.fn.winsaveview())
    assert.are.same({ 2, 2 }, vim.api.nvim_buf_get_mark(buf, 'a'))
    assert.are.same({ 1, 2 }, vim.api.nvim_buf_get_extmark_by_id(buf, ns, mark, {}))
    vim.cmd('silent earlier 1f')
    assert.are.equal(edited, text(buf))
    vim.cmd('silent redo')
    assert.are.equal(current.content, text(buf))
  end)

  it('holds a save marker when the saved snapshot is no longer an ancestor of the current state', function()
    set(buf, edited)
    local written = capture()
    vim.cmd('silent undo')
    set(buf, 'different branch')
    local current = capture()
    expect_error('HISTORY_HELD', function() history.record_save(current, written) end)
    assert.are.equal(current.content, text(buf))
    assert.are.same(current.tree, vim.fn.undotree())
  end)

  it('holds a save marker if undo joining changed the captured snapshot', function()
    set(buf, edited)
    local written = capture()
    vim.cmd('undojoin')
    set(buf, 'joined changes')
    local current = capture()
    expect_error('HISTORY_HELD', function() history.record_save(current, written) end)
    assert.are.equal(current.content, text(buf))
    assert.are.same(current.tree, vim.fn.undotree())
  end)

  it('rejects a stale save-marker capture before importing history', function()
    set(buf, edited)
    local written = capture()
    set(buf, 'later changes')
    local current = capture()
    set(buf, 'newer changes')
    local before = vim.fn.undotree()
    expect_error('STALE_BUFFER', function() history.record_save(current, written) end)
    assert.are.equal('newer changes', text(buf))
    assert.are.same(before, vim.fn.undotree())
  end)

  it('records a root-state save with the same counter and missing header marker as native saving', function()
    local written = capture()
    set(buf, edited)
    local current = capture()
    local expected = vim.deepcopy(current.tree)
    expected.save_cur, expected.save_last = 1, 1
    history.record_save(current, written)
    assert.are.same(expected, vim.fn.undotree())
    -- Neovim has no header on which to store a root marker. Compare traversal
    -- with an actual native root write rather than inventing a new target.
    local native = vim.api.nvim_create_buf(false, true)
    vim.bo[native].buftype = ''
    vim.api.nvim_buf_set_name(native, current.directory .. '/native.tex')
    local native_content = vim.api.nvim_buf_call(native, function()
      vim.bo[native].undolevels = -1
      set(native, base)
      vim.bo[native].undolevels = 1000
      vim.cmd('silent noautocmd write')
      set(native, edited)
      vim.cmd('silent earlier 1f')
      return text(native)
    end)
    vim.api.nvim_buf_delete(native, { force = true })
    vim.cmd('silent earlier 1f')
    assert.are.equal(native_content, text(buf))
  end)

  it('holds a marker if pruning removed a captured history state', function()
    set(buf, edited)
    local written = capture()
    vim.bo[buf].undolevels = -1
    set(buf, 'replacement root')
    vim.bo[buf].undolevels = 1000
    set(buf, 'new history')
    local current = capture()
    expect_error('HISTORY_HELD', function() history.record_save(current, written) end)
    assert.are.same(current.tree, vim.fn.undotree())
    assert.are.equal(current.content, text(buf))
  end)

  for _, stage in ipairs({ 'scratch', 'live' }) do
    it('preserves the original history if save-marker import is rejected in ' .. stage, function()
      set(buf, edited)
      local written = capture()
      set(buf, 'later changes')
      local current = capture()
      local original_cmd = vim.cmd
      vim.cmd = function(cmd)
        if
          cmd:find('rundo', 1, true)
          and cmd:find('saved.undo', 1, true)
          and (vim.api.nvim_get_current_buf() == buf) == (stage == 'live')
        then
          return -- :rundo can fail without raising a Lua error.
        end
        return original_cmd(cmd)
      end
      local ok, err = pcall(history.record_save, current, written)
      vim.cmd = original_cmd
      assert.is_false(ok)
      assert.is_truthy(tostring(err):find('HISTORY_HELD', 1, true))
      assert.are.same(current.tree, vim.fn.undotree())
      assert.are.equal(current.changedtick, vim.api.nvim_buf_get_changedtick(buf))
      assert.are.equal(current.content, text(buf))
      vim.cmd('silent undo')
      assert.are.equal(edited, text(buf))
    end)
  end

  it('restores original markers if a live import raises after applying its metadata', function()
    set(buf, edited)
    local written = capture()
    set(buf, 'later changes')
    local current = capture()
    local original_cmd = vim.cmd
    vim.cmd = function(cmd)
      local result = original_cmd(cmd)
      if vim.api.nvim_get_current_buf() == buf and cmd:find('rundo', 1, true) and cmd:find('saved.undo', 1, true) then
        error('injected failure after import')
      end
      return result
    end
    local ok, err = pcall(history.record_save, current, written)
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('injected failure after import', 1, true))
    assert.are.same(current.tree, vim.fn.undotree())
    assert.are.equal(current.changedtick, vim.api.nvim_buf_get_changedtick(buf))
    assert.are.equal(current.content, text(buf))
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

  it('preserves manual folds and jump destinations while installing incoming lines', function()
    set(buf, 'one\ntwo\nthree\nfour\nfive\nsix\nending')
    vim.wo.foldmethod = 'manual'
    vim.cmd('2,4fold')
    vim.cmd('normal! G')
    vim.cmd('normal! gg')
    local jumps = vim.fn.getjumplist()[1]
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = 'incoming\n' .. node.content
    end
    history.install(snapshot, result, true)
    assert.are.equal(3, vim.fn.foldclosed(3))
    assert.are.equal(5, vim.fn.foldclosedend(3))
    local after = vim.fn.getjumplist()[1]
    assert.are.equal(#jumps, #after)
    for i, jump in ipairs(jumps) do
      assert.are.equal(jump.bufnr, after[i].bufnr)
      if jump.bufnr == buf then assert.are.equal(jump.lnum + 1, after[i].lnum) end
    end
    vim.cmd('normal! zE')
  end)

  it('keeps the historical edit cursor on its text after incoming lines are inserted', function()
    vim.api.nvim_win_set_cursor(0, { 3, 2 })
    vim.cmd('normal! rX')
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = 'incoming\n' .. node.content
    end
    history.install(snapshot, result, true)
    vim.cmd('silent undo')
    assert.are.equal('incoming\n' .. base, text(buf))
    assert.are.same({ 4, 2 }, vim.api.nvim_win_get_cursor(0))
    vim.cmd('silent redo')
    assert.are.same({ 4, 2 }, vim.api.nvim_win_get_cursor(0))
  end)

  it('maps historical edit cursors independently across alternate undo branches', function()
    vim.api.nvim_win_set_cursor(0, { 3, 2 })
    vim.cmd('normal! rX')
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    vim.api.nvim_win_set_cursor(0, { 1, 2 })
    vim.cmd('normal! rY')
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    vim.cmd('silent undo')
    vim.api.nvim_win_set_cursor(0, { 2, 1 })
    vim.cmd('normal! rZ')
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = 'incoming\n' .. node.content
    end
    history.install(snapshot, result, true)
    vim.cmd('silent undo')
    assert.are.same({ 3, 1 }, vim.api.nvim_win_get_cursor(0))
    vim.cmd('silent undo')
    assert.are.same({ 4, 2 }, vim.api.nvim_win_get_cursor(0))
    vim.cmd('silent undo 2')
    assert.are.same({ 2, 2 }, vim.api.nvim_win_get_cursor(0))
    assert.are.equal('incoming\ninYro\nseparator\nenXing', text(buf))
  end)

  it('preserves positions inside an unchanged span between two edits on the same Unicode line', function()
    set(buf, 'left 😀 middle 日本 right')
    local col = #'left 😀 mid'
    vim.api.nvim_win_set_cursor(0, { 1, col })
    vim.api.nvim_buf_set_mark(buf, 'a', 1, col, {})
    vim.api.nvim_buf_set_mark(buf, '<', 1, col, {})
    vim.api.nvim_buf_set_mark(buf, '>', 1, col + 3, {})
    local namespace = vim.api.nvim_create_namespace('overleaf-inline-position-test')
    local mark = vim.api.nvim_buf_set_extmark(buf, namespace, 0, col, {})
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = node.content:gsub('left', 'LEFT INSERT'):gsub('right', 'RIGHT INSERT')
    end
    history.install(snapshot, result, true)
    local expected = col + #'LEFT INSERT' - #'left'
    assert.are.same({ 1, expected }, vim.api.nvim_win_get_cursor(0))
    assert.are.same({ 1, expected }, vim.api.nvim_buf_get_mark(buf, 'a'))
    assert.are.same({ 1, expected }, vim.api.nvim_buf_get_mark(buf, '<'))
    assert.are.same({ 1, expected + 3 }, vim.api.nvim_buf_get_mark(buf, '>'))
    assert.are.same({ 0, expected }, vim.api.nvim_buf_get_extmark_by_id(buf, namespace, mark, {}))
  end)

  it('preserves independent cursors and horizontal views in every window showing the document', function()
    set(buf, string.rep('prefix ', 30) .. 'target' .. string.rep(' suffix', 30))
    local first = vim.api.nvim_get_current_win()
    vim.wo[first].wrap = false
    vim.fn.winrestview({ lnum = 1, col = 180, curswant = 180, leftcol = 140 })
    vim.cmd('vsplit')
    local second = vim.api.nvim_get_current_win()
    vim.wo[second].wrap = false
    vim.fn.winrestview({ lnum = 1, col = 230, curswant = 230, leftcol = 190 })
    local views = {}
    for _, win in ipairs({ first, second }) do
      views[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    end
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    for _, node in ipairs(result.nodes) do
      node.content = 'new ' .. node.content
    end
    local ok, err = pcall(history.install, snapshot, result, true)
    local actual = {}
    for _, win in ipairs({ first, second }) do
      actual[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    end
    vim.api.nvim_win_close(second, true)
    assert.is_true(ok, tostring(err))
    for _, win in ipairs({ first, second }) do
      assert.are.equal(views[win].col + 4, actual[win].col)
      assert.are.equal(views[win].curswant + 4, actual[win].curswant)
      assert.are.equal(views[win].leftcol, actual[win].leftcol)
      assert.are.equal(views[win].topline, actual[win].topline)
    end
  end)

  it('restores cursor and named selection marks exactly when a native import rolls back', function()
    set(buf, edited)
    vim.api.nvim_win_set_cursor(0, { 3, 2 })
    vim.api.nvim_buf_set_mark(buf, 'a', 3, 2, {})
    vim.api.nvim_buf_set_mark(buf, '<', 3, 1, {})
    vim.api.nvim_buf_set_mark(buf, '>', 3, 4, {})
    local snapshot = capture()
    local original_cmd = vim.cmd
    vim.cmd = function(cmd)
      if vim.api.nvim_get_current_buf() == buf and cmd:find('candidate.undo', 1, true) then
        error('injected positional rollback')
      end
      return original_cmd(cmd)
    end
    local ok = pcall(history.install, snapshot, incoming(snapshot), true)
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.are.same({ 3, 2 }, vim.api.nvim_win_get_cursor(0))
    assert.are.same({ 3, 2 }, vim.api.nvim_buf_get_mark(buf, 'a'))
    assert.are.same({ 3, 1 }, vim.api.nvim_buf_get_mark(buf, '<'))
    assert.are.same({ 3, 4 }, vim.api.nvim_buf_get_mark(buf, '>'))
  end)

  for _, pair in ipairs({
    { 'a', 'a\nb' },
    { 'a\nb', 'a' },
    { 'a', 'a\n' },
    { 'a\n', 'a' },
    { '', '😀\n日本' },
    { '😀\n日本', '' },
    { 'a\nb\nc', 'a\nnew\nb\nc' },
    { 'a\nb\nc', 'a\nc' },
    { 'a\nb\nc', 'a\nB\nC' },
    { '😀 one\n😀 two', '😃 one\n😃 two' },
  }) do
    it('reconstructs exact multiline positions for ' .. vim.inspect(pair), function()
      vim.bo[buf].undolevels = -1
      set(buf, pair[1])
      vim.bo[buf].undolevels = 1000
      local snapshot = capture()
      local result = vim.deepcopy(snapshot.history)
      result.nodes[1].content = pair[2]
      result.nodes[1].empty = false
      history.install(snapshot, result, true)
      assert.are.equal(pair[2], text(buf))
    end)
  end

  it('updates a small change within a long line without treating the unchanged text as diff work', function()
    local padding = string.rep('x', 150000)
    vim.bo[buf].undolevels = -1
    set(buf, padding .. ' old ' .. padding)
    vim.bo[buf].undolevels = 1000
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    result.nodes[1].content = padding .. ' new ' .. padding
    history.install(snapshot, result, true)
    assert.are.equal(result.nodes[1].content, text(buf))
  end)

  it('holds excessive changed-block diff work before changing live text, marks, or undo', function()
    vim.bo[buf].undolevels = -1
    set(buf, string.rep('x', 150000))
    vim.bo[buf].undolevels = 1000
    vim.api.nvim_buf_set_mark(buf, 'a', 1, 4, {})
    local snapshot = capture()
    local result = vim.deepcopy(snapshot.history)
    result.nodes[1].content = string.rep('y', 150000)
    expect_error('HISTORY_LIMIT', function() history.install(snapshot, result, true) end)
    assert.are.equal(snapshot.content, text(buf))
    assert.are.same(snapshot.tree, vim.fn.undotree())
    assert.are.same({ 1, 4 }, vim.api.nvim_buf_get_mark(buf, 'a'))
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

  it('retains native text and undo when a private capture exceeds the history limit', function()
    local directory = vim.fn.tempname()
    vim.bo[buf].undolevels = 1100
    for i = 1, 1000 do
      set(buf, tostring(i))
    end
    local tree = vim.fn.undotree()
    local ok, err = pcall(history.capture, buf, { directory = directory, document = 'doc', session = 'session' })
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('HISTORY_LIMIT', 1, true))
    local entries = vim.fn.glob(directory .. '/overleaf-history-*', false, true)
    assert.are.equal(1, #entries)
    assert.are.equal('1000', read(entries[1] .. '/buffer.txt'))
    assert.are.equal('1000', vim.json.decode(read(entries[1] .. '/snapshot.json')).content)
    assert.are.equal(1, vim.fn.filereadable(entries[1] .. '/original.undo'))
    assert.are.same(tree, vim.fn.undotree())
    assert.are.equal('1000', text(buf))
    vim.fn.delete(directory, 'rf')
  end)

  it('retains raw native NUL text when automatic history capture is unsupported', function()
    local directory = vim.fn.tempname()
    vim.bo[buf].binary = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'before\0after', 'last' })
    local ok, err = pcall(history.capture, buf, { directory = directory, document = 'doc' })
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('INVALID_HISTORY', 1, true))
    local entries = vim.fn.glob(directory .. '/overleaf-history-*', false, true)
    assert.are.equal(1, #entries)
    assert.are.equal('before\0after\nlast', read(entries[1] .. '/buffer.txt'))
    assert.are.same({ 'before\0after', 'last' }, vim.api.nvim_buf_get_lines(buf, 0, -1, false))
    vim.fn.delete(directory, 'rf')
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
