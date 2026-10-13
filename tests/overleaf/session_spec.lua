local bridge = require('overleaf.bridge')

local function rpc(method, params)
  local done, failure, result = false, nil, nil
  bridge.request(method, params, function(err, value)
    failure, result, done = err, value, true
  end)
  assert.is_true(vim.wait(5000, function() return done end), method .. ' timed out')
  assert.is_nil(failure, vim.inspect(failure))
  return result
end

local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end

local function set(buf, value)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(value, '\n', { plain = true }))
  vim.bo[buf].undolevels = vim.bo[buf].undolevels
end

describe('durable editor sessions', function()
  local buf, root, binding, client, statuses, delayed, delay_action, fail_action, requests, recovery, wrong_identity
  local controller_options
  local base = 'intro\nseparator\nending'
  local first = 'MY intro\nseparator\nending'
  local second = 'MY unsaved intro\nseparator\nending'

  local function idle()
    assert.is_true(vim.wait(5000, function() return client:idle() end), vim.inspect(statuses))
    assert.are_not.equal('error', statuses[#statuses] and statuses[#statuses].status, vim.inspect(statuses))
  end

  local function document(action, fields)
    return rpc(
      'syncDocument',
      vim.tbl_extend('force', {
        session = binding.session,
        document = binding.document,
        action = action,
      }, fields or {})
    )
  end

  before_each(function()
    statuses, delayed, requests, recovery = {}, {}, {}, {}
    delay_action, fail_action, wrong_identity = nil, nil, nil
    local started, failure = false, nil
    bridge.start(function(err)
      failure, started = err, true
    end)
    assert.is_true(vim.wait(5000, function() return started end))
    assert.is_nil(failure)
    root = vim.fn.tempname()
    vim.fn.mkdir(root, 'p')
    local file = assert(io.open(root .. '/main.tex', 'wb'))
    file:write(base)
    file:close()
    vim.cmd('silent noautocmd edit ' .. vim.fn.fnameescape(root .. '/main.tex'))
    buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].endofline = false
    vim.bo[buf].fixendofline = false
    vim.bo[buf].undolevels = -1
    set(buf, base)
    vim.bo[buf].undolevels = 1000
    vim.bo[buf].modified = false
    local session =
      rpc('syncOpen', { root = root .. '/recovery', server = 'https://example.test', projectId = 'project' })
    binding = rpc('syncDocument', {
      session = session.session,
      document = 'doc',
      action = 'open',
      initial = { content = base, version = 1 },
    })
    controller_options = {
      modified = function(content)
        local disk = assert(io.open(root .. '/main.tex', 'rb'))
        local value = disk:read('*a')
        disk:close()
        return content ~= value
      end,
      saved = function()
        local disk = assert(io.open(root .. '/main.tex', 'rb'))
        local value = disk:read('*a')
        disk:close()
        return value
      end,
      on_status = function(status, detail) statuses[#statuses + 1] = { status = status, detail = detail } end,
      request = function(method, params, callback)
        requests[#requests + 1] = vim.deepcopy(params)
        if params.action == fail_action then
          callback({ code = 'DISK_FULL', message = 'injected checkpoint failure' })
          return
        end
        bridge.request(method, params, function(err, result)
          if params.action == 'prepare' and wrong_identity and result then result[wrong_identity] = 'obsolete' end
          if params.action == delay_action then
            delay_action = nil
            delayed[#delayed + 1] = function() callback(err, result) end
          else
            callback(err, result)
          end
        end)
      end,
    }
    client = require('overleaf.editor.session').attach(buf, binding, controller_options)
    idle()
  end)

  local function reopen_text(content)
    client:stop()
    rpc('syncClose', { session = binding.session })
    vim.api.nvim_buf_delete(buf, { force = true })
    local file = assert(io.open(root .. '/main.tex', 'wb'))
    file:write(content)
    file:close()
    vim.cmd('silent noautocmd edit ' .. vim.fn.fnameescape(root .. '/main.tex'))
    buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].undolevels = 1000
    vim.bo[buf].fixendofline = false
    vim.bo[buf].modified = false
    local session =
      rpc('syncOpen', { root = root .. '/recovery', server = 'https://example.test', projectId = 'codec' })
    binding = rpc('syncDocument', {
      session = session.session,
      document = 'doc',
      action = 'open',
      initial = { content = content, version = 1 },
    })
    client = require('overleaf.editor.session').attach(buf, binding, controller_options)
    idle()
  end

  for _, mode in ipairs({ 'v', 'V', '\22' }) do
    it(
      'defers incoming buffer installation during ' .. vim.inspect(mode) .. ' selection and resumes on leaving it',
      function()
        vim.api.nvim_win_set_cursor(0, { 3, 1 })
        vim.cmd('normal! ' .. mode)
        vim.cmd('normal! l')
        local cursor, anchor = vim.api.nvim_win_get_cursor(0), vim.fn.getpos('v')
        document('remote', { remote = { content = 'intro\nseparator\nTHEIR ending', version = 2 } })
        client:refresh()
        vim.wait(100, function() return false end, 10)
        local actual = { text(buf), vim.fn.mode(), vim.api.nvim_win_get_cursor(0), vim.fn.getpos('v') }
        vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'nx', false)
        assert.are.same({ base, mode, cursor, anchor }, actual)
        idle()
        assert.are.equal('intro\nseparator\nTHEIR ending', text(buf))
      end
    )
  end

  after_each(function()
    if client then
      for _, directory in ipairs(client:stop()) do
        recovery[directory] = true
      end
    end
    for _, deliver in ipairs(delayed) do
      deliver()
    end
    if binding then rpc('syncClose', { session = binding.session }) end
    bridge.stop()
    vim.wait(1500, function() return not bridge.is_running() end)
    if buf and vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
    -- Retained recovery files here belong only to disposable failure fixtures.
    for directory in pairs(recovery) do
      vim.fn.delete(directory, 'rf')
    end
    if root then vim.fn.delete(root, 'rf') end
    client, binding, buf = nil, nil, nil
  end)

  it('delivers unsaved checkpoints and receives independent edits without publishing them', function()
    set(buf, first)
    vim.api.nvim_exec_autocmds('TextChanged', { buffer = buf })
    idle()
    local snapshot = document('snapshot').result
    assert.are.equal(first, snapshot.buffer)
    assert.are.equal(base, snapshot.saved)
    assert.is_truthy(snapshot.editor.checkpoint.undo)
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    idle()
    assert.are.equal(first:gsub('ending', 'THEIR ending'), text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal(base:gsub('ending', 'THEIR ending'), text(buf))
  end)

  it('round-trips DOS text, Unicode, final newlines, and local undo through the real bridge', function()
    local original = 'intro\r\nseparator\r\né😀\r\n'
    reopen_text(original)
    assert.are.equal('dos', vim.bo[buf].fileformat)
    assert.is_true(vim.bo[buf].endofline)
    set(buf, 'MY intro\nseparator\né😀')
    client:refresh()
    idle()
    document('remote', { remote = { content = 'intro\r\nseparator\r\nTHEIR é😀\r\n', version = 2 } })
    idle()
    assert.are.equal('MY intro\nseparator\nTHEIR é😀', text(buf))
    assert.are.equal(3, vim.api.nvim_buf_line_count(buf))
    vim.cmd('silent undo')
    assert.are.equal('intro\nseparator\nTHEIR é😀', text(buf))
    vim.cmd('silent write')
    idle()
    assert.are.equal('intro\r\nseparator\r\nTHEIR é😀\r\n', document('snapshot').result.saved)
  end)

  it('records the final newline actually written by fixendofline while the option stays unset', function()
    reopen_text('text')
    vim.bo[buf].fixendofline = true
    vim.cmd('silent write')
    idle()
    assert.is_false(vim.bo[buf].endofline)
    assert.are.equal('text\n', document('snapshot').result.saved)
    assert.are.equal('text', document('snapshot').result.buffer)
    assert.are.equal('text\n', controller_options.saved())
  end)

  it('compares incoming buffer modifications with the bytes an ordinary save would write', function()
    vim.bo[buf].fixendofline = true
    set(buf, base .. ' local')
    vim.cmd('silent write')
    idle()
    local incoming = 'THEIR intro\nseparator\nending'
    -- The workspace has installed the merged saved revision before the native
    -- import. fixendofline supplies the disk newline, while endofline stays off.
    local file = assert(io.open(root .. '/main.tex', 'wb'))
    file:write(incoming .. ' local\n')
    file:close()
    document('remote', { remote = { content = incoming, version = 2 } })
    idle()
    assert.are.equal(incoming .. ' local', text(buf), vim.inspect(statuses))
    assert.is_false(vim.bo[buf].modified)
    assert.is_false(vim.bo[buf].endofline)
    assert.are.equal(incoming .. ' local\n', document('snapshot').result.saved)
  end)

  it('observes BOM-only option edits without publishing until an actual save', function()
    reopen_text('text\n')
    vim.bo[buf].bomb = true
    vim.api.nvim_exec_autocmds('OptionSet', { pattern = 'bomb' })
    idle()
    local bom = '\239\187\191'
    assert.are.equal(bom .. 'text\n', document('snapshot').result.buffer)
    assert.are.equal('text\n', document('snapshot').result.saved)
    vim.cmd('silent write')
    idle()
    assert.are.equal(bom .. 'text\n', document('snapshot').result.saved)
  end)

  it('pauses a mismatched save while retaining the native checkpoint and external disk text', function()
    client.saved = function()
      local file = assert(io.open(root .. '/main.tex', 'wb'))
      file:write('external writer')
      file:close()
      return 'external writer'
    end
    set(buf, first)
    vim.cmd('silent write')
    assert.is_true(vim.wait(5000, function() return client.paused end))
    assert.are.equal('SAVE_MISMATCH', statuses[#statuses].detail.code)
    assert.are.equal('external writer', controller_options.saved())
    assert.are.equal(first, text(buf))
    assert.are.equal(base, document('snapshot').result.saved)
    assert.is_true(#statuses[#statuses].detail.recovery > 0)
  end)

  it('captures saved A before newer unsaved B while replies and incoming C are delayed', function()
    delay_action = 'save'
    set(buf, first)
    vim.cmd('silent write')
    set(buf, second)
    client:refresh()
    assert.is_true(vim.wait(5000, function() return #delayed == 1 end))
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    table.remove(delayed, 1)()
    idle()
    assert.are.equal(second:gsub('ending', 'THEIR ending'), text(buf))
    assert.are.equal(first:gsub('ending', 'THEIR ending'), document('snapshot').result.saved)
    assert.is_true(vim.bo[buf].modified)
  end)

  it('holds unsupported native undo and retries automatically on an ordinary write', function()
    set(buf, first)
    vim.cmd('silent write')
    idle()
    set(buf, second)
    vim.cmd('silent write')
    idle()
    vim.cmd('silent undo')
    client:refresh()
    idle()
    local tree = vim.fn.undotree()
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    idle()
    assert.are.equal(first, text(buf))
    assert.are.same(tree, vim.fn.undotree())
    assert.are.equal('undo-metadata', document('snapshot').result.editor.held.reason)
    vim.cmd('silent write')
    idle()
    assert.are.equal(first:gsub('ending', 'THEIR ending'), text(buf))
    assert.are.equal(vim.NIL, document('snapshot').result.editor.held)
  end)

  it('recomputes a delayed proposal instead of replacing newer local typing', function()
    set(buf, first)
    client:refresh()
    idle()
    delay_action = 'prepare'
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    assert.is_true(vim.wait(5000, function() return #delayed == 1 end))
    set(buf, second)
    client:refresh()
    table.remove(delayed, 1)()
    idle()
    assert.are.equal(second:gsub('ending', 'THEIR ending'), text(buf))
    assert.are.equal(base:gsub('ending', 'THEIR ending'), document('snapshot').result.saved)
  end)

  it('rebases a long undo history again after sustained edits outdate an incoming proposal', function()
    for i = 1, 128 do
      set(buf, 'local ' .. i .. '\nseparator\nending')
    end
    client:refresh()
    idle()
    delay_action = 'prepare'
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    assert.is_true(vim.wait(5000, function() return #delayed == 1 end))
    for i = 129, 160 do
      set(buf, 'local ' .. i .. '\nseparator\nending')
      client:refresh()
    end
    local before = vim.fn.undotree()
    table.remove(delayed, 1)()
    idle()
    assert.are.same(before, vim.fn.undotree())
    assert.are.equal('local 160\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent undo 80')
    assert.are.equal('local 80\nseparator\nTHEIR ending', text(buf))
    vim.cmd('silent undo 0')
    assert.are.equal(base:gsub('ending', 'THEIR ending'), text(buf))
    assert.are.equal(base:gsub('ending', 'THEIR ending'), document('snapshot').result.saved)
  end)

  it('captures the latest native text and undo when detached before its scheduled checkpoint', function()
    set(buf, second)
    local before = vim.fn.undotree()
    local paths = client:stop()
    assert.is_true(#paths > 0)
    local found = false
    for _, directory in ipairs(paths) do
      recovery[directory] = true
      local snapshot = vim.json.decode(table.concat(vim.fn.readfile(directory .. '/snapshot.json'), '\n'))
      if snapshot.content == second then
        found = true
        assert.are.equal(before.seq_cur, snapshot.history.current)
      end
    end
    assert.is_true(found)
    assert.are.equal(second, text(buf))
    assert.are.same(before, vim.fn.undotree())
    assert.is_true(vim.bo[buf].modified)
  end)

  it('ignores callbacks after detaching even if the buffer is reused', function()
    delay_action = 'prepare'
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    assert.is_true(vim.wait(5000, function() return #delayed == 1 end))
    for _, directory in ipairs(client:stop()) do
      recovery[directory] = true
    end
    set(buf, 'unrelated new editing session')
    table.remove(delayed, 1)()
    vim.wait(30, function() return false end)
    assert.are.equal('unrelated new editing session', text(buf))
  end)

  it('retains recovery files and pauses imports when checkpoint persistence fails', function()
    fail_action = 'checkpoint'
    set(buf, second)
    client:refresh()
    assert.is_true(vim.wait(5000, function() return statuses[#statuses].status == 'error' end))
    assert.is_true(#statuses[#statuses].detail.recovery > 0)
    document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    assert.are.equal(second, text(buf))
    local paths = client:stop()
    assert.is_true(#paths > 0)
    for _, directory in ipairs(paths) do
      recovery[directory] = true
      assert.are.equal(1, vim.fn.filereadable(directory .. '/snapshot.json'))
    end
  end)

  for _, field in ipairs({ 'session', 'document' }) do
    it('rejects a reply for an obsolete ' .. field .. ' without changing the buffer', function()
      wrong_identity = field
      document('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
      assert.is_true(vim.wait(5000, function() return statuses[#statuses].status == 'error' end))
      assert.are.equal('STALE_REPLY', statuses[#statuses].detail.code)
      assert.are.equal(base, text(buf))
    end)
  end

  it('retries a history-size hold on a later save without discarding native history', function()
    vim.bo[buf].undolevels = 1100
    for i = 1, 1000 do
      set(buf, tostring(i))
    end
    local tree = vim.fn.undotree()
    client:refresh()
    assert.is_true(vim.wait(5000, function() return client:idle() end))
    assert.are.equal('held', statuses[#statuses].status)
    assert.are.equal('history-limit', statuses[#statuses].detail.reason)
    assert.are.same(tree, vim.fn.undotree())
    -- Explicitly shorten history as a user preference, then make a normal save.
    vim.bo[buf].undolevels = 2
    set(buf, first)
    vim.cmd('silent write')
    idle()
    assert.are.equal(first, document('snapshot').result.saved)
  end)

  it('drains the old bridge before allowing a new process to start', function()
    client:stop()
    rpc('syncClose', { session = binding.session })
    binding = nil
    bridge.stop()
    local rejected
    bridge.start(function(err) rejected = err end)
    assert.are.equal('STOPPING', rejected and rejected.code)
    assert.is_true(vim.wait(5000, function() return not bridge.is_running() end))
    local started, failure = false, nil
    bridge.start(function(err)
      failure, started = err, true
    end)
    assert.is_true(vim.wait(5000, function() return started end))
    assert.is_nil(failure)
    assert.are.equal('ok', rpc('ping', {}).status)
  end)
  it('resolves an overlapping historical state while preserving native undo and the current peer edit', function()
    set(buf, 'OLD intro\nseparator\nending')
    set(buf, base)
    idle()
    local incoming = 'THEIR intro\nseparator\nending'
    document('remote', { remote = { content = incoming, version = 2 } })
    client:refresh()
    idle()
    assert.are.equal('history-conflict', statuses[#statuses].detail.reason)
    local before = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    local review = client:review_history()
    local conflict = client:resolve_history(review, {})
    assert.are.equal('conflict', conflict.status)
    assert.are.equal(1, conflict.seq)
    assert.are.equal(base, text(buf))
    local result = client:resolve_history(review, { ['1'] = 'OLD with THEIR intro\nseparator\nending' })
    assert.are.equal('accepted', result.status)
    idle()
    assert.are.equal(incoming, text(buf))
    local after = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    assert.are.equal(before.seq_cur, after.seq_cur)
    assert.are.equal(before.seq_last, after.seq_last)
    vim.api.nvim_buf_call(buf, function() vim.cmd('undo') end)
    assert.are.equal('OLD with THEIR intro\nseparator\nending', text(buf))
    vim.api.nvim_buf_call(buf, function() vim.cmd('undo') end)
    assert.are.equal(incoming, text(buf))
    local disk = assert(io.open(root .. '/main.tex', 'rb'))
    assert.are.equal(base, disk:read('*a'))
    disk:close()
  end)

  it('rejects history choices after newer typing without replacing text or history', function()
    set(buf, 'OLD intro\nseparator\nending')
    set(buf, base)
    idle()
    document('remote', { remote = { content = 'THEIR intro\nseparator\nending', version = 2 } })
    client:refresh()
    idle()
    local review = client:review_history()
    set(buf, 'NEW typing\nseparator\nending')
    local tree = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    local ok = pcall(client.resolve_history, client, review, { ['1'] = 'choice' })
    assert.is_false(ok)
    assert.are.equal('NEW typing\nseparator\nending', text(buf))
    assert.are.same(tree, vim.api.nvim_buf_call(buf, vim.fn.undotree))
  end)
  it('resolves saved text independently from dirty text through the real bridge and native undo', function()
    set(buf, first)
    vim.api.nvim_buf_call(buf, function() vim.cmd('write') end)
    idle()
    local unsaved = 'MY intro\nseparator\nUNSAVED ending'
    set(buf, unsaved)
    idle()
    local incoming = 'THEIR intro\nseparator\nending'
    document('remote', { remote = { content = incoming, version = 2 } })
    client:refresh()
    idle()
    local review = client:review_conflict()
    local saved = 'RESOLVED intro\nseparator\nending'
    local partial = client:resolve_conflict(review, { saved = saved })
    assert.are.equal('history', partial.stage)
    assert.are.equal(unsaved, text(buf))
    local accepted = client:resolve_conflict(review, { saved = saved, history = { ['0'] = incoming } })
    assert.are.equal('accepted', accepted.status)
    idle()
    assert.are.equal('RESOLVED intro\nseparator\nUNSAVED ending', text(buf))
    local state = document('snapshot').result
    assert.are.equal(saved, state.saved)
    assert.are.equal(vim.NIL, state.conflict)
    vim.api.nvim_buf_call(buf, function() vim.cmd('undo') end)
    assert.are.equal(saved, text(buf))
    vim.api.nvim_buf_call(buf, function() vim.cmd('undo') end)
    assert.are.equal(incoming, text(buf))
  end)
end)
