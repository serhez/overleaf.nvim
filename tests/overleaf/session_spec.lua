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
end)
