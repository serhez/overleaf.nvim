local bridge = require('overleaf.bridge')
local editor = require('overleaf.editor.session')

local function rpc(method, params)
  local done, err, result = false, nil, nil
  bridge.request(method, params, function(failure, reply)
    err, result, done = failure, reply, true
  end)
  assert.is_true(vim.wait(5000, function() return done end), method .. ' timed out')
  assert.is_nil(err, vim.inspect(err))
  return result
end

local function read(path)
  local file = assert(io.open(path, 'rb'))
  local result = file:read('*a')
  file:close()
  return result
end

local function write(path, content)
  local file = assert(io.open(path, 'wb'))
  assert(file:write(content))
  assert(file:close())
end

local function set(buf, text)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, '\n', { plain = true }))
  vim.bo[buf].undolevels = vim.bo[buf].undolevels
  vim.api.nvim_exec_autocmds('TextChanged', { buffer = buf })
end

local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end

describe('workspace editor integration', function()
  local root, filename, binding, buf, client, statuses, during_write, write_requests, lose_reply, late_reply
  local second_buf, second_client, undo_path, original_undodir, backup_options
  local base = 'intro\nseparator\nending'
  local function doc(action, fields)
    return rpc(
      'syncDocument',
      vim.tbl_extend('force', {
        session = binding.session,
        document = binding.document,
        action = action,
      }, fields or {})
    )
  end
  local function idle()
    assert.is_true(vim.wait(5000, function() return client:idle() end), vim.inspect(statuses))
    assert.is_false(client.paused or false, vim.inspect(statuses))
  end
  local function second_document()
    local name = root .. '/sources/second.tex'
    write(name, base)
    second_buf = vim.fn.bufadd(name)
    vim.fn.bufload(second_buf)
    vim.bo[second_buf].fixendofline = false
    local second_binding = rpc('syncDocument', {
      session = binding.session,
      document = 'second',
      action = 'open',
      path = 'second.tex',
      initial = { content = base, version = 1 },
    })
    second_client = editor.attach(second_buf, second_binding, {
      on_status = function(status, detail) statuses[#statuses + 1] = { status = status, detail = detail } end,
    })
    assert.is_true(vim.wait(5000, function() return second_client:idle() end))
    assert.is_false(second_client.paused or false, vim.inspect(statuses))
    return name
  end
  before_each(function()
    undo_path = nil
    original_undodir = vim.o.undodir
    backup_options = {}
    for _, name in ipairs({ 'backup', 'backupdir', 'backupext', 'backupskip', 'patchmode' }) do
      backup_options[name] = vim.o[name]
    end
    vim.o.undodir = '.'
    statuses, during_write, write_requests, lose_reply, late_reply = {}, nil, 0, false, nil
    local started = false
    bridge.start(function(err)
      assert.is_nil(err)
      started = true
    end)
    assert.is_true(vim.wait(5000, function() return started end))
    root = vim.fn.tempname()
    vim.fn.mkdir(root .. '/sources', 'p')
    filename = root .. '/sources/main.tex'
    write(filename, base)
    vim.cmd('silent noautocmd edit ' .. vim.fn.fnameescape(filename))
    buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].fixendofline = false
    local session = rpc('syncOpen', {
      root = root .. '/state',
      sourceRoot = root .. '/sources',
      server = 'https://example.test',
      projectId = 'project',
    })
    binding = rpc('syncDocument', {
      session = session.session,
      document = 'doc',
      action = 'open',
      path = 'main.tex',
      initial = { content = base, version = 1 },
    })
    client = editor.attach(buf, binding, {
      on_status = function(status, detail) statuses[#statuses + 1] = { status = status, detail = detail } end,
      request = function(method, params, callback)
        if params.action == 'write' then write_requests = write_requests + 1 end
        if params.action == 'write' and during_write then
          local callback_during_write = during_write
          during_write = nil
          vim.schedule(callback_during_write)
        end
        bridge.request(method, params, function(err, reply)
          if params.action == 'write' and lose_reply then
            lose_reply = false
            late_reply = function() callback(err, reply) end
            callback({ code = 'TIMEOUT', message = 'injected lost completion' })
          else
            callback(err, reply)
          end
        end)
      end,
    })
    idle()
  end)
  after_each(function()
    vim.o.undodir = original_undodir
    for name, value in pairs(backup_options) do
      vim.o[name] = value
    end
    local recovery = client and client:stop() or {}
    if second_client then vim.list_extend(recovery, second_client:stop()) end
    if binding then rpc('syncClose', { session = binding.session }) end
    bridge.stop()
    vim.wait(1500, function() return not bridge.is_running() end)
    if buf and vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
    if second_buf and vim.api.nvim_buf_is_valid(second_buf) then
      vim.api.nvim_buf_delete(second_buf, { force = true })
    end
    for _, directory in ipairs(recovery) do
      vim.fn.delete(directory, 'rf')
    end
    vim.fn.delete(root, 'rf')
    client, binding, second_buf, second_client = nil, nil, nil, nil
  end)

  it('reattaches an archived unsaved buffer and its native history after reopening the project', function()
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    set(buf, 'UNSAVED ' .. base)
    idle()
    local tree = vim.fn.undotree()
    client:stop()
    rpc('syncClose', { session = binding.session })
    vim.api.nvim_buf_delete(buf, { force = true })
    vim.cmd('silent noautocmd edit ' .. vim.fn.fnameescape(filename))
    buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].fixendofline = false
    local reopened = rpc('syncOpen', {
      root = root .. '/state',
      sourceRoot = root .. '/sources',
      server = 'https://example.test',
      projectId = 'project',
    })
    binding = rpc('syncDocument', { session = reopened.session, document = 'doc', action = 'open', path = 'main.tex' })
    assert.is_true(binding.state.editorAttached)
    client = editor.restore(buf, binding, {
      on_status = function(status, detail) statuses[#statuses + 1] = { status = status, detail = detail } end,
    })
    idle()
    assert.are.equal('UNSAVED ' .. base, text(buf))
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal(tree.seq_cur, vim.fn.undotree().seq_cur)
    assert.are.equal(tree.save_last, vim.fn.undotree().save_last)
    vim.cmd('silent undo')
    assert.are.equal('SAVED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent redo')
    vim.cmd('silent redo')
    assert.are.equal('UNSAVED ' .. base, text(buf))
  end)

  it('recovers an uncertain save from an explicit disk review without discarding live text or captures', function()
    set(buf, 'SAVED ' .. base)
    lose_reply = true
    local ok = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_true(client.paused)
    set(buf, 'NEWER unsaved ' .. base)
    local history = vim.fn.undotree()
    local review = client:inspect()
    assert.are.equal('SAVED ' .. base, vim.base64.decode(review.disk.observed.bytes))
    assert.is_true(#review.captures > 0)
    client:recover_disk(review)
    idle()
    assert.are.equal('NEWER unsaved ' .. base, text(buf))
    assert.are.same(history, vim.fn.undotree())
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.is_true(#client:inspect().captures > 0)
    vim.cmd('silent write')
    idle()
    assert.are.equal('NEWER unsaved ' .. base, read(filename))
  end)

  it('refuses a stale recovery review and leaves the paused editor and newer disk contents intact', function()
    set(buf, 'SAVED ' .. base)
    lose_reply = true
    assert.is_false(pcall(vim.cmd, 'silent write'))
    local review = client:inspect()
    write(filename, 'external after review')
    local ok, err = pcall(client.recover_disk, client, review)
    assert.is_false(ok)
    assert.is_truthy(vim.inspect(err):find('STALE_FILE', 1, true), vim.inspect(err))
    assert.is_true(client.paused)
    assert.are.equal('SAVED ' .. base, text(buf))
    assert.are.equal('external after review', read(filename))
  end)

  it('retains configured backups and patchmode originals through ordinary guarded saves', function()
    vim.o.backup, vim.o.backupskip, vim.o.backupdir, vim.o.patchmode = true, '', '.', '.orig'
    vim.bo[buf].undofile = true
    set(buf, 'FIRST ' .. base)
    vim.cmd('silent write')
    idle()
    assert.are.equal(base, read(filename .. '~'))
    assert.are.equal(base, read(filename .. '.orig'))
    set(buf, 'SECOND ' .. base)
    vim.cmd('silent write')
    idle()
    assert.are.equal('FIRST ' .. base, read(filename .. '~'))
    assert.are.equal(base, read(filename .. '.orig'))
    assert.are.equal('SECOND ' .. base, read(filename))
    assert.is_truthy(read(vim.fn.undofile(filename)))
  end)

  for _, kind in ipairs({ 'relative', 'full-path', 'escaped-comma' }) do
    it('selects the configured backup directory: ' .. kind, function()
      vim.o.backup, vim.o.backupskip, vim.o.backupext = true, '', '.bak'
      local destination
      if kind == 'relative' then
        vim.o.backupdir = './.backup'
        destination = root .. '/sources/.backup/main.tex.bak'
      elseif kind == 'full-path' then
        vim.o.backupdir = root .. '/missing,' .. root .. '/backups//'
        destination = root .. '/backups/' .. vim.api.nvim_buf_get_name(buf):gsub('/', '%%') .. '.bak'
      else
        vim.o.backupdir = root .. '/backups\\,with-comma'
        destination = root .. '/backups,with-comma/main.tex.bak'
      end
      set(buf, 'SAVED ' .. base)
      vim.cmd('silent write')
      idle()
      assert.are.equal(base, read(destination))
      assert.are.equal('SAVED ' .. base, read(filename))
    end)
  end

  it('honors backupskip for both backup and patchmode files', function()
    vim.o.backup, vim.o.backupskip, vim.o.backupdir, vim.o.patchmode = true, '*.tex', '.', '.orig'
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    assert.are.equal(0, vim.fn.filereadable(filename .. '~'))
    assert.are.equal(0, vim.fn.filereadable(filename .. '.orig'))
    assert.are.equal('SAVED ' .. base, read(filename))
  end)

  it('keeps an existing patchmode original without replacing its contents', function()
    local other = second_document()
    vim.o.backup, vim.o.backupskip, vim.o.backupdir = true, '', '.'
    vim.o.patchmode = '.orig'
    write(filename .. '.orig', 'oldest original')
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    assert.are.equal('oldest original', read(filename .. '.orig'))
    assert.are.equal(base, read(other))
  end)

  it('honors persistent undo destinations and disabling without deleting old archives', function()
    vim.bo[buf].undofile = true
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    local first = vim.fn.undofile(filename)
    local original = read(first)
    vim.o.undodir = root .. '/different/undo'
    set(buf, 'SECOND ' .. base)
    vim.cmd('silent write')
    idle()
    local second = vim.fn.undofile(filename)
    assert.are_not.equal(first, second)
    assert.are.equal(original, read(first))
    local newest = read(second)
    vim.bo[buf].undofile = false
    set(buf, 'THIRD ' .. base)
    vim.cmd('silent write')
    idle()
    assert.are.equal('THIRD ' .. base, read(filename))
    assert.are.equal(original, read(first))
    assert.are.equal(newest, read(second))
    doc('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    client:refresh()
    idle()
    assert.are.equal(('THIRD ' .. base):gsub('ending', 'THEIR ending'), read(filename))
    assert.are.equal(newest, read(second))
  end)

  it('does not duplicate persistent save markers on a repeated clean save', function()
    vim.bo[buf].undofile = true
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    local before = read(vim.fn.undofile(filename))
    vim.cmd('silent write')
    idle()
    assert.are.equal(before, read(vim.fn.undofile(filename)))
    assert.are.equal(1, vim.fn.undotree().save_last)
  end)

  it('freezes the persistent destination when options change while a write is pending', function()
    vim.bo[buf].undofile = true
    set(buf, 'SAVED ' .. base)
    local destination = vim.fn.undofile(filename)
    during_write = function() vim.o.undodir = root .. '/new-destination' end
    local ok, err = pcall(vim.cmd, 'write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true), tostring(err))
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.is_truthy(read(destination))
    assert.are.equal(0, vim.fn.isdirectory(root .. '/new-destination'))
    idle()
    vim.cmd('silent write')
    idle()
    assert.is_truthy(read(vim.fn.undofile(filename)))
  end)

  for _, content in ipairs({ 'first\n', '' }) do
    it('saves native readback history through the guarded controller: ' .. vim.inspect(content), function()
      vim.bo[buf].undofile = true
      set(buf, content)
      vim.cmd('silent write')
      idle()
      local state = doc('diskState')
      assert.is_truthy(state.result.record.state.undo.checkpoint)
      assert.are.equal(content, read(filename))
      assert.are.equal(content, text(buf))
      local undo = read(vim.fn.undofile(filename))
      assert.is_truthy(undo:find('Vim', 1, true))
    end)
  end

  it('updates persistent saved history while a joined unsaved edit has removed its live undo state', function()
    undo_path = binding.workspace.root .. '/.main.tex.un~'
    vim.bo[buf].undofile = true
    local saved, unsaved = 'SAVED ' .. base, 'UNSAVED ' .. base
    set(buf, saved)
    vim.cmd('silent write')
    vim.cmd('undojoin')
    set(buf, unsaved)
    doc('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
    idle()
    assert.are.equal(saved:gsub('ending', 'THEIR ending'), read(filename))
    assert.are.equal(unsaved:gsub('ending', 'THEIR ending'), text(buf))
    assert.is_true(vim.bo[buf].modified)
    local process = vim
      .system({ 'nvim', '--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', '/dev/stdin' }, {
        env = { OVERLEAF_REOPEN_SOURCE = filename },
        stdin = [[
vim.o.undodir, vim.o.undofile = '.', true
vim.cmd('silent edit ' .. vim.fn.fnameescape(vim.env.OVERLEAF_REOPEN_SOURCE))
local function text() return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false), '\n') end
assert(text() == 'SAVED intro\nseparator\nTHEIR ending')
assert(vim.fn.undotree().save_last == 1)
vim.cmd('silent undo')
assert(text() == 'intro\nseparator\nTHEIR ending')
assert(vim.bo.modified)
vim.cmd('silent redo')
assert(text() == 'SAVED intro\nseparator\nTHEIR ending')
assert(not vim.bo.modified)
]],
      })
      :wait(10000)
    assert.are.equal(0, process.code, process.stderr)
    vim.cmd('silent undo')
    assert.are.equal(base:gsub('ending', 'THEIR ending'), text(buf))
  end)

  it('holds an unsupported persistent import without changing the source and permits another save', function()
    undo_path = binding.workspace.root .. '/.main.tex.un~'
    vim.bo[buf].undofile = true
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    local history = require('overleaf.editor.history')
    local original, before = history.rebase_saved, read(undo_path)
    history.rebase_saved = function() error('HISTORY_HELD: injected native rejection') end
    local ok, err = pcall(function()
      doc('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
      idle()
      assert.are.equal('SAVED ' .. base, read(filename))
      assert.are.equal(before, read(undo_path))
      assert.are.equal(vim.NIL, doc('snapshot').result.disk.pending)
      assert.are.equal('held', statuses[#statuses].status)
      set(buf, 'NEW ' .. base)
      vim.cmd('silent write')
      assert.are.equal('NEW ' .. base, read(filename))
    end)
    history.rebase_saved = original
    assert.is_true(ok, tostring(err))
  end)

  it('retries a persistent proposal superseded during native preparation without pausing the editor', function()
    undo_path = binding.workspace.root .. '/.main.tex.un~'
    vim.bo[buf].undofile = true
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    local history = require('overleaf.editor.history')
    local original, raced = history.rebase_saved, false
    history.rebase_saved = function(...)
      local result = original(...)
      if not raced then
        raced = true
        doc('remote', { remote = { content = base:gsub('ending', 'NEWER ending'), version = 3 } })
        set(buf, 'UNSAVED ' .. base)
      end
      return result
    end
    local ok, err = pcall(function()
      doc('remote', { remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 } })
      idle()
      assert.is_true(raced)
      assert.are.equal('SAVED ' .. base:gsub('ending', 'NEWER ending'), read(filename))
      assert.are.equal('UNSAVED ' .. base:gsub('ending', 'NEWER ending'), text(buf))
      assert.is_true(vim.bo[buf].modified)
    end)
    history.rebase_saved = original
    assert.is_true(ok, tostring(err))
  end)

  it('writes saved A plus incoming C while preserving unsaved B and local-only undo', function()
    local a = 'A intro\nseparator\nending'
    local b = 'A plus B\nseparator\nending'
    set(buf, a)
    idle()
    vim.cmd('silent write')
    set(buf, b)
    doc('remote', { remote = { content = base:gsub('ending', 'C ending'), version = 2 } })
    idle()
    assert.are.equal(a:gsub('ending', 'C ending'), read(filename))
    assert.are.equal(b:gsub('ending', 'C ending'), text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal(a:gsub('ending', 'C ending'), text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal(base:gsub('ending', 'C ending'), text(buf))
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal(a:gsub('ending', 'C ending'), doc('snapshot').result.saved)
  end)

  it('writes each bound document independently with wall and preserves the current buffer', function()
    local second_name = second_document()
    set(buf, 'FIRST ' .. base)
    set(second_buf, 'SECOND ' .. base)
    local formatted = 0
    vim.api.nvim_create_autocmd('BufWritePre', {
      buffer = second_buf,
      callback = function()
        formatted = formatted + 1
        set(second_buf, 'FORMATTED ' .. base)
      end,
    })
    vim.cmd('silent wall')
    assert.are.equal(buf, vim.api.nvim_get_current_buf())
    assert.are.equal('FIRST ' .. base, read(filename))
    assert.are.equal('FORMATTED ' .. base, read(second_name))
    assert.is_false(vim.bo[buf].modified)
    assert.is_false(vim.bo[second_buf].modified)
    assert.are.equal(1, vim.api.nvim_buf_call(buf, vim.fn.undotree).save_last)
    assert.are.equal(1, vim.api.nvim_buf_call(second_buf, vim.fn.undotree).save_last)
    vim.cmd('silent wall')
    assert.are.equal(1, formatted)
    assert.are.equal('FIRST ' .. base, doc('snapshot').result.saved)
    local snapshot = rpc('syncDocument', { session = binding.session, document = 'second', action = 'snapshot' })
    assert.are.equal('FORMATTED ' .. base, snapshot.result.saved)
  end)

  it('includes edits to a later document that arrive while wall awaits an earlier save', function()
    local second_name = second_document()
    set(buf, 'FIRST ' .. base)
    set(second_buf, 'SECOND ' .. base)
    during_write = function() set(second_buf, 'LATER SECOND ' .. base) end
    vim.cmd('silent wall')
    assert.are.equal('FIRST ' .. base, read(filename))
    assert.are.equal('LATER SECOND ' .. base, read(second_name))
    assert.is_false(vim.bo[buf].modified)
    assert.is_false(vim.bo[second_buf].modified)
  end)

  it('preserves an external revision when wall saves one document but cannot safely save the next', function()
    local second_name = second_document()
    set(buf, 'FIRST ' .. base)
    set(second_buf, 'SECOND ' .. base)
    -- Change the second file after :wall has begun, so neither watcher timing
    -- nor pre-command checkpoint work can hide the expected-byte mismatch.
    vim.api.nvim_create_autocmd('BufWritePre', {
      buffer = second_buf,
      once = true,
      callback = function() write(second_name, 'EXTERNAL ' .. base) end,
    })
    local ok, err = pcall(vim.cmd, 'silent wall')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('DISK_CHANGED', 1, true))
    assert.are.equal('FIRST ' .. base, read(filename))
    assert.are.equal('EXTERNAL ' .. base, read(second_name))
    assert.are.equal('SECOND ' .. base, text(second_buf))
    assert.is_false(vim.bo[buf].modified)
    assert.is_true(vim.bo[second_buf].modified)
  end)

  it('automatically reconciles repeated external atomic saves through directory notifications', function()
    set(buf, 'MY ' .. base)
    idle()
    for _, ending in ipairs({ 'first external', 'second external' }) do
      local external = base:gsub('ending', ending)
      write(filename .. '.tmp', external)
      assert(os.rename(filename .. '.tmp', filename))
      assert.is_true(vim.wait(5000, function() return text(buf) == 'MY ' .. external end), vim.inspect(statuses))
      idle()
      assert.are.equal(external, doc('snapshot').result.saved)
    end
    vim.cmd('silent undo')
    assert.are.equal(base:gsub('ending', 'second external'), text(buf))
  end)

  it('keeps overlapping external changes on disk and preserves the unsaved native buffer', function()
    set(buf, base:gsub('ending', 'MY ending'))
    idle()
    local external = base:gsub('ending', 'THEIR ending')
    write(filename, external)
    client:refresh()
    idle()
    assert.are.equal(external, read(filename))
    assert.are.equal(base:gsub('ending', 'MY ending'), text(buf))
    assert.is_truthy(doc('snapshot').result.conflict)
  end)

  it('prevents checktime from importing disk changes through ordinary native reload', function()
    local before = vim.fn.undotree()
    write(filename, base:gsub('ending', 'external ending'))
    vim.cmd('silent checktime')
    assert.are.equal(base, text(buf))
    assert.are.same(before, vim.fn.undotree())
    client:refresh()
    idle()
    assert.are.equal(base:gsub('ending', 'external ending'), text(buf))
  end)

  it('blocks a normal save from overwriting an external revision the editor has not reconciled', function()
    set(buf, 'MY ' .. base)
    idle()
    local external = base:gsub('ending', 'external ending')
    write(filename, external)
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('DISK_CHANGED', 1, true))
    assert.are.equal(external, read(filename))
    idle()
    assert.are.equal('MY ' .. external, text(buf))
    vim.cmd('silent write')
    idle()
    assert.are.equal('MY ' .. external, read(filename))
    local later = 'MY ' .. base:gsub('ending', 'later external ending')
    write(filename, later)
    ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('DISK_CHANGED', 1, true))
    assert.are.equal(later, read(filename))
    idle()
    assert.are.equal(later, text(buf))
  end)

  it('keeps listeners and marks attached across guarded saves and subsequent typing', function()
    local events, detached = 0, false
    assert.is_true(vim.api.nvim_buf_attach(buf, false, {
      on_lines = function() events = events + 1 end,
      on_detach = function() detached = true end,
    }))
    set(buf, 'MY ' .. base)
    idle()
    vim.api.nvim_buf_set_mark(buf, 'a', 2, 2, {})
    local ns = vim.api.nvim_create_namespace('workspace-save')
    local id = vim.api.nvim_buf_set_extmark(buf, ns, 1, 2, {})
    vim.cmd('silent write')
    assert.is_false(detached)
    assert.are.same({ 2, 2 }, vim.api.nvim_buf_get_mark(buf, 'a'))
    assert.are.same({ 1, 2 }, vim.api.nvim_buf_get_extmark_by_id(buf, ns, id, {}))
    local before = events
    set(buf, 'LATER ' .. base)
    assert.is_true(events > before)
    idle()
    assert.are.equal('MY ' .. base, read(filename))
  end)

  it('runs formatting and post-write hooks once and preserves native save traversal', function()
    local pre, post = 0, 0
    vim.api.nvim_create_autocmd('BufWritePre', {
      buffer = buf,
      callback = function()
        pre = pre + 1
        set(buf, 'FORMATTED ' .. base)
      end,
    })
    vim.api.nvim_create_autocmd('BufWritePost', { buffer = buf, callback = function() post = post + 1 end })
    set(buf, 'MY ' .. base)
    vim.cmd('silent write')
    assert.are.equal('FORMATTED ' .. base, read(filename))
    assert.are.equal(1, pre)
    assert.are.equal(1, post)
    assert.are.equal(1, vim.fn.undotree().save_last)
    assert.is_false(vim.bo[buf].modified)
    idle()
  end)

  it('finalizes a clean-buffer formatter save once and preserves undo/redo saved state', function()
    assert.is_false(vim.bo[buf].modified)
    local pre, post = 0, 0
    vim.api.nvim_create_autocmd('BufWritePre', {
      buffer = buf,
      callback = function()
        pre = pre + 1
        set(buf, 'FORMATTED ' .. base)
      end,
    })
    vim.api.nvim_create_autocmd('BufWritePost', { buffer = buf, callback = function() post = post + 1 end })
    vim.cmd('silent write')
    assert.are.equal('FORMATTED ' .. base, read(filename))
    assert.is_false(vim.bo[buf].modified)
    assert.are.equal(1, pre)
    assert.are.equal(1, post)
    assert.are.equal(1, write_requests)
    assert.are.equal(1, vim.fn.undotree().save_last)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent redo')
    assert.are.equal('FORMATTED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    idle()
  end)

  it('keeps existing alternate branches and file-based undo after formatting a clean saved buffer', function()
    set(buf, 'FIRST ' .. base)
    vim.cmd('silent write')
    local first = vim.fn.undotree().seq_cur
    set(buf, 'ALTERNATE ' .. base)
    local alternate = vim.fn.undotree().seq_cur
    vim.cmd('silent undo ' .. first)
    assert.is_false(vim.bo[buf].modified)
    vim.api.nvim_create_autocmd(
      'BufWritePre',
      { buffer = buf, once = true, callback = function() set(buf, 'FORMATTED ' .. base) end }
    )
    vim.cmd('silent write')
    assert.are.equal(2, write_requests)
    assert.are.equal(2, vim.fn.undotree().save_last)
    vim.cmd('silent earlier 1f')
    assert.are.equal('FIRST ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent later 1f')
    assert.are.equal('FORMATTED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent undo ' .. alternate)
    assert.are.equal('ALTERNATE ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    idle()
  end)

  it('rejects recursive saves from formatting hooks before any disk write', function()
    local nested_ok, nested_error
    vim.api.nvim_create_autocmd('BufWritePre', {
      buffer = buf,
      once = true,
      nested = true,
      callback = function()
        nested_ok, nested_error = pcall(vim.cmd, 'silent write')
        set(buf, 'FORMATTED ' .. base)
      end,
    })
    vim.cmd('silent write')
    assert.is_false(nested_ok)
    assert.is_truthy(tostring(nested_error):find('SAVE_BUSY', 1, true))
    assert.are.equal(1, write_requests)
    assert.are.equal('FORMATTED ' .. base, read(filename))
    assert.are.equal(1, vim.fn.undotree().save_last)
    idle()
  end)

  it('retains a dirty buffer and recovery capture if native save finalization fails', function()
    vim.api.nvim_create_autocmd(
      'BufWritePre',
      { buffer = buf, once = true, callback = function() set(buf, 'FORMATTED ' .. base) end }
    )
    local original_cmd = vim.cmd
    vim.cmd = function(command)
      if command == 'silent keepalt keepjumps write' then error('injected finalization failure') end
      return original_cmd(command)
    end
    local ok, err = pcall(vim.cmd, 'silent write')
    vim.cmd = original_cmd
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('injected finalization failure', 1, true))
    assert.are.equal('FORMATTED ' .. base, read(filename))
    assert.are.equal('FORMATTED ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    assert.is_true(client.paused)
    assert.is_nil(client.finalizing)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent redo')
    assert.are.equal('FORMATTED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    assert.is_true(#client:stop() > 0)
    assert.are.equal(1, write_requests)
  end)

  it('refuses native completion when the write handler was removed while awaiting the disk write', function()
    vim.api.nvim_create_autocmd(
      'BufWritePre',
      { buffer = buf, once = true, callback = function() set(buf, 'FORMATTED ' .. base) end }
    )
    during_write = function()
      for _, autocmd in ipairs(vim.api.nvim_get_autocmds({ event = 'BufWriteCmd', buffer = buf })) do
        vim.api.nvim_del_autocmd(autocmd.id)
      end
    end
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_FINALIZATION', 1, true))
    assert.is_true(vim.bo[buf].modified)
    assert.is_true(client.paused)
    assert.are.equal(1, write_requests)
    assert.are.equal('FORMATTED ' .. base, read(filename))
  end)

  it('refuses native completion when write events are disabled while awaiting the save', function()
    local ignored = vim.o.eventignore
    vim.api.nvim_create_autocmd(
      'BufWritePre',
      { buffer = buf, once = true, callback = function() set(buf, 'FORMATTED ' .. base) end }
    )
    during_write = function() vim.o.eventignore = 'BufWriteCmd' end
    local ok, err = pcall(vim.cmd, 'silent write')
    vim.o.eventignore = ignored
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_FINALIZATION', 1, true))
    assert.is_true(vim.bo[buf].modified)
    assert.is_true(client.paused)
    assert.are.equal(1, write_requests)
    assert.are.equal('FORMATTED ' .. base, read(filename))
  end)

  it('keeps an uncertain save dirty and ignores late completion instead of acknowledging it', function()
    set(buf, 'SAVED ' .. base)
    idle()
    lose_reply = true
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('TIMEOUT', 1, true))
    assert.is_true(client.paused)
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.are.equal(0, vim.fn.undotree().save_last)
    set(buf, 'LATER ' .. base)
    late_reply()
    late_reply = nil
    assert.is_true(client.paused)
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal('LATER ' .. base, text(buf))
    assert.are.equal(0, vim.fn.undotree().save_last)
    assert.is_true(#client:stop() > 0)
    assert.are.equal('SAVED ' .. base, doc('snapshot').result.saved)
  end)

  it('rejects an existing custom write handler when attaching a workspace buffer', function()
    client:stop()
    vim.api.nvim_create_autocmd('BufWriteCmd', { buffer = buf, callback = function() end })
    local ok, err = pcall(editor.attach, buf, binding)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('WRITE_HANDLER_CONFLICT', 1, true))
    assert.are.equal(base, read(filename))
  end)

  it('retains later callback edits as unsaved when they arrive during a guarded write', function()
    set(buf, 'SAVED ' .. base)
    idle()
    during_write = function() set(buf, 'LATER ' .. base) end
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.are.equal('LATER ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal('SAVED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent redo')
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent redo')
    assert.are.equal('LATER ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    idle()
    assert.are.equal('SAVED ' .. base, doc('snapshot').result.saved)
  end)

  it('preserves post-write edits as unsaved and reports that only the captured text was saved', function()
    set(buf, 'SAVED ' .. base)
    idle()
    vim.api.nvim_create_autocmd(
      'BufWritePost',
      { buffer = buf, once = true, callback = function() set(buf, 'POST ' .. base) end }
    )
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.are.equal('POST ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal('SAVED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    idle()
  end)

  for _, phase in ipairs({ 'during', 'after' }) do
    it('records the committed snapshot once for file-based undo when edits arrive ' .. phase .. ' saving', function()
      set(buf, 'FIRST ' .. base)
      vim.cmd('silent write')
      set(buf, 'SAVED ' .. base)
      idle()
      local saved = vim.fn.undotree().seq_cur
      local function later() set(buf, 'LATER ' .. base) end
      if phase == 'during' then
        during_write = later
      else
        vim.api.nvim_create_autocmd('BufWritePost', { buffer = buf, once = true, callback = later })
      end
      local ok, err = pcall(vim.cmd, 'silent write')
      assert.is_false(ok)
      assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
      assert.are.equal(2, write_requests)
      assert.are.equal(2, vim.fn.undotree().save_last)
      assert.are.equal('SAVED ' .. base, read(filename))
      assert.are.equal('LATER ' .. base, text(buf))
      local later_seq = vim.fn.undotree().seq_cur
      vim.cmd('silent earlier 1f')
      assert.are.equal(saved, vim.fn.undotree().seq_cur)
      assert.are.equal('SAVED ' .. base, text(buf))
      assert.is_false(vim.bo[buf].modified)
      vim.cmd('silent earlier 1f')
      assert.are.equal('FIRST ' .. base, text(buf))
      assert.is_true(vim.bo[buf].modified)
      vim.cmd('silent later 1f')
      assert.are.equal('SAVED ' .. base, text(buf))
      vim.cmd('silent undo ' .. later_seq)
      assert.are.equal('LATER ' .. base, text(buf))
      assert.is_true(vim.bo[buf].modified)
      idle()
    end)
  end

  it('does not add another marker when clean-buffer formatting already finalized before a post-write edit', function()
    vim.api.nvim_create_autocmd('BufWritePre', {
      buffer = buf,
      once = true,
      callback = function() set(buf, 'FORMATTED ' .. base) end,
    })
    vim.api.nvim_create_autocmd('BufWritePost', {
      buffer = buf,
      once = true,
      callback = function() set(buf, 'POST ' .. base) end,
    })
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
    assert.are.equal(1, write_requests)
    assert.are.equal(1, vim.fn.undotree().save_last)
    vim.cmd('silent earlier 1f')
    assert.are.equal('FORMATTED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
  end)

  it('preserves alternate branches and previous markers when repairing an interrupted save', function()
    set(buf, 'FIRST ' .. base)
    vim.cmd('silent write')
    local first = vim.fn.undotree().seq_cur
    set(buf, 'ALTERNATE ' .. base)
    local alternate = vim.fn.undotree().seq_cur
    vim.cmd('silent undo ' .. first)
    set(buf, 'SAVED ' .. base)
    idle()
    local saved = vim.fn.undotree().seq_cur
    during_write = function() set(buf, 'LATER ' .. base) end
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
    assert.are.equal(2, vim.fn.undotree().save_last)
    vim.cmd('silent undo ' .. alternate)
    assert.are.equal('ALTERNATE ' .. base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent undo ' .. saved)
    assert.are.equal('SAVED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent earlier 1f')
    assert.are.equal('FIRST ' .. base, text(buf))
  end)

  it('does not add a marker for a clean repeated save interrupted by newer edits', function()
    set(buf, 'SAVED ' .. base)
    vim.cmd('silent write')
    idle()
    during_write = function() set(buf, 'LATER ' .. base) end
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
    assert.are.equal(1, vim.fn.undotree().save_last)
    vim.cmd('silent earlier 1f')
    assert.are.equal('SAVED ' .. base, text(buf))
  end)

  for _, change in ipairs({ 'branch', 'older-save-position', 'joined-edit' }) do
    it('retains recovery captures when a callback changes the ' .. change .. ' during a save', function()
      set(buf, 'FIRST ' .. base)
      vim.cmd('silent write')
      local first = vim.fn.undotree().seq_cur
      set(buf, 'SAVED ' .. base)
      if change == 'older-save-position' then
        vim.cmd('silent write')
        vim.cmd('silent undo ' .. first)
      end
      idle()
      local written = text(buf)
      local before = vim.fn.undotree()
      local after_callback
      during_write = function()
        if change == 'branch' then vim.cmd('silent undo ' .. first) end
        if change == 'joined-edit' then vim.cmd('undojoin') end
        set(buf, 'LATER ' .. base)
        after_callback = vim.fn.undotree()
      end
      local ok, err = pcall(vim.cmd, 'silent write')
      assert.is_false(ok)
      assert.is_truthy(tostring(err):find('HISTORY_HELD', 1, true))
      assert.is_true(client.paused)
      assert.are.equal(written, read(filename))
      assert.are.equal('LATER ' .. base, text(buf))
      assert.is_true(vim.bo[buf].modified)
      assert.are.same(after_callback, vim.fn.undotree())
      assert.are.equal(before.save_last, vim.fn.undotree().save_last)
      assert.is_true(#client:stop() >= 2)
      assert.are.equal(written, doc('snapshot').result.saved)
    end)
  end

  it('corrects undo saved state before a chained buffer deletion can discard text', function()
    set(buf, 'SAVED ' .. base)
    idle()
    during_write = function() set(buf, 'LATER ' .. base) end
    assert.is_false(pcall(vim.cmd, 'silent write'))
    vim.cmd('silent undo')
    local ok, err = pcall(vim.cmd, 'silent undo | bdelete')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('E89', 1, true))
    assert.is_true(vim.api.nvim_buf_is_loaded(buf))
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
  end)

  it('compares undo states with actual disk bytes before an external change is reconciled', function()
    set(buf, 'MY ' .. base)
    idle()
    write(filename, 'EXTERNAL ' .. base)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
  end)

  it('keeps undo states dirty when the source cannot be safely read', function()
    set(buf, 'MY ' .. base)
    idle()
    assert(os.rename(filename, filename .. '.moved'))
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
  end)

  it('compares BOM, CRLF, and fixed final newlines when undoing an interrupted save', function()
    set(buf, 'SAVED ' .. base)
    vim.bo[buf].bomb = true
    vim.bo[buf].fileformat = 'dos'
    vim.bo[buf].fixendofline = true
    idle()
    during_write = function() set(buf, 'LATER ' .. base) end
    assert.is_false(pcall(vim.cmd, 'silent write'))
    assert.are.equal(string.char(239, 187, 191) .. ('SAVED ' .. base):gsub('\n', '\r\n') .. '\r\n', read(filename))
    vim.cmd('silent undo')
    assert.are.equal('SAVED ' .. base, text(buf))
    assert.is_false(vim.bo[buf].modified)
    vim.cmd('silent undo')
    assert.is_true(vim.bo[buf].modified)
  end)

  it('keeps undo saved-state checks active after a post-write hook fails', function()
    set(buf, 'SAVED ' .. base)
    idle()
    vim.api.nvim_create_autocmd('BufWritePost', {
      buffer = buf,
      once = true,
      callback = function() error('injected post-write failure') end,
    })
    local ok, err = pcall(vim.cmd, 'silent write')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('injected post-write failure', 1, true))
    assert.are.equal('SAVED ' .. base, read(filename))
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
    vim.cmd('silent redo')
    assert.is_false(vim.bo[buf].modified)
  end)

  for _, empty in ipairs({ false, true }) do
    for _, bomb in ipairs({ false, true }) do
      it('compares empty=' .. tostring(empty) .. ', BOM=' .. tostring(bomb) .. ' undo states exactly', function()
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, empty and {} or { '' })
        vim.bo[buf].undolevels = vim.bo[buf].undolevels
        vim.bo[buf].bomb = bomb
        vim.bo[buf].fixendofline = true
        during_write = function() set(buf, 'LATER ' .. base) end
        assert.is_false(pcall(vim.cmd, 'silent write'))
        assert.are.equal((bomb and string.char(239, 187, 191) or '') .. (empty and '' or '\n'), read(filename))
        vim.cmd('silent undo')
        assert.are.equal('', text(buf))
        assert.is_false(vim.bo[buf].modified)
        vim.cmd('silent redo')
        assert.is_true(vim.bo[buf].modified)
      end)
    end
  end

  it('does not declare unsupported encodings saved during history navigation', function()
    set(buf, 'MY ' .. base)
    idle()
    vim.bo[buf].fileencoding = 'latin1'
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_true(vim.bo[buf].modified)
  end)

  it('stops correcting native modified flags after the controller is detached', function()
    set(buf, 'MY ' .. base)
    idle()
    client:stop()
    write(filename, 'EXTERNAL ' .. base)
    vim.cmd('silent undo')
    assert.are.equal(base, text(buf))
    assert.is_false(vim.bo[buf].modified)
  end)

  it('rejects partial writes, appends, encoding overrides, and alternate targets before writing', function()
    set(buf, 'MY ' .. base)
    idle()
    for _, command in ipairs({
      '1write!',
      'write! >> ' .. vim.fn.fnameescape(filename),
      'write ++enc=latin1',
      'write ' .. vim.fn.fnameescape(root .. '/export.tex'),
    }) do
      local ok, err = pcall(vim.cmd, 'silent ' .. command)
      assert.is_false(ok, command)
      assert.is_truthy(tostring(err):find('UNSUPPORTED_WRITE', 1, true), tostring(err))
      assert.are.equal(base, read(filename))
      assert.is_true(vim.bo[buf].modified)
    end
    assert.are.equal(0, vim.fn.filereadable(root .. '/export.tex'))
  end)

  it('writes the exact BOM and CRLF bytes with native newline options', function()
    set(buf, 'MY ' .. base)
    vim.bo[buf].bomb = true
    vim.bo[buf].fileformat = 'dos'
    vim.bo[buf].fixendofline = true
    vim.cmd('silent write')
    assert.are.equal(string.char(239, 187, 191) .. ('MY ' .. base):gsub('\n', '\r\n') .. '\r\n', read(filename))
    assert.is_false(vim.bo[buf].modified)
    idle()
  end)

  it('leaves clean update calls alone and does not create save markers for clean repeated saves', function()
    vim.cmd('silent update')
    assert.are.equal(0, vim.fn.undotree().save_last)
    set(buf, 'MY ' .. base)
    vim.cmd('silent write')
    assert.are.equal(1, vim.fn.undotree().save_last)
    vim.cmd('silent write')
    assert.are.equal(1, vim.fn.undotree().save_last)
    idle()
  end)

  it('keeps newer edits open when a write-and-quit command encounters a post-write mutation', function()
    set(buf, 'SAVED ' .. base)
    idle()
    -- Another window prevents a successful :wq from ending this test process.
    vim.cmd('vsplit')
    local window = vim.api.nvim_get_current_win()
    vim.api.nvim_create_autocmd(
      'BufWritePost',
      { buffer = buf, once = true, callback = function() set(buf, 'POST ' .. base) end }
    )
    local ok, err = pcall(vim.cmd, 'silent wq')
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('SAVE_CHANGED', 1, true))
    assert.is_true(vim.api.nvim_win_is_valid(window))
    assert.is_true(vim.bo[buf].modified)
    assert.are.equal('POST ' .. base, text(buf))
    vim.api.nvim_win_close(window, true)
    idle()
  end)

  it('finishes the durable save before write-and-quit closes its window', function()
    set(buf, 'SAVED ' .. base)
    idle()
    vim.cmd('vsplit')
    local window = vim.api.nvim_get_current_win()
    during_write = function() assert.is_true(vim.api.nvim_win_is_valid(window)) end
    vim.cmd('silent wq')
    assert.is_false(vim.api.nvim_win_is_valid(window))
    assert.are.equal('SAVED ' .. base, read(filename))
    assert.are.equal('SAVED ' .. base, doc('snapshot').result.saved)
    idle()
  end)

  it('refuses a renamed buffer rather than reading or saving another file under the old identity', function()
    local other = root .. '/sources/other.tex'
    write(other, 'unrelated')
    vim.api.nvim_buf_set_name(buf, other)
    set(buf, 'local edit')
    assert.is_true(vim.wait(5000, function() return client.paused end))
    assert.are.equal('unrelated', read(other))
    assert.are.equal(base, read(filename))
  end)
  it('resolves persistent history explicitly without losing the saved or live native branches', function()
    vim.bo[buf].undofile = true
    set(buf, 'OLD intro\nseparator\nending')
    set(buf, base)
    vim.cmd('silent write')
    idle()
    local incoming = 'THEIR intro\nseparator\nending'
    doc('remote', { remote = { content = incoming, version = 2 } })
    idle()
    assert.are.equal(base, read(filename))
    local review = client:review_disk_history()
    assert.are.equal(1, review.conflict.seq)
    local choices = { ['1'] = 'OLD with THEIR intro\nseparator\nending' }
    local preview = client:resolve_disk_history(review, choices, true)
    assert.are.equal('ready', preview.status)
    idle()
    assert.are.equal(base, read(filename), 'preview must not allow automatic publication')
    local result = client:resolve_disk_history(review, choices)
    assert.are.equal('accepted', result.status)
    idle()
    assert.are.equal(incoming, read(filename))
    assert.are.equal(base, text(buf), 'live history still needs its own resolution')
    local live_review = client:review_history()
    client:resolve_history(live_review, choices)
    idle()
    assert.are.equal(incoming, text(buf))
    local process = vim
      .system({ 'nvim', '--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', '/dev/stdin' }, {
        env = { OVERLEAF_REOPEN_SOURCE = filename },
        stdin = [[
vim.o.undodir, vim.o.undofile = '.', true
vim.cmd('silent edit ' .. vim.fn.fnameescape(vim.env.OVERLEAF_REOPEN_SOURCE))
local function text() return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false), '\n') end
assert(text() == 'THEIR intro\nseparator\nending')
vim.cmd('silent undo')
assert(text() == 'OLD with THEIR intro\nseparator\nending')
vim.cmd('silent undo')
assert(text() == 'THEIR intro\nseparator\nending')
]],
      })
      :wait(10000)
    assert.are.equal(0, process.code, process.stderr)
  end)
end)
