local bridge = require('overleaf.bridge')
local sync = require('overleaf.sync')
local uv = vim.uv or vim.loop

local function rpc(method, params)
  local done, failure, result = false, nil, nil
  bridge.request(method, params, function(err, reply)
    failure, result, done = err, reply, true
  end)
  assert.is_true(vim.wait(10000, function() return done end), method .. ' timed out')
  assert.is_nil(failure, vim.inspect(failure))
  return result
end

local function finish(start)
  local done, failure, result = false, nil, nil
  start(function(err, value)
    failure, result, done = err, value, true
  end)
  assert.is_true(vim.wait(10000, function() return done end), 'Project operation timed out')
  assert.is_nil(failure, vim.inspect(failure))
  return result
end

local function read(filename)
  local file = assert(io.open(filename, 'rb'))
  local value = file:read('*a')
  assert(file:close())
  return value
end

local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end

describe('ordinary project editing', function()
  local root, options, buffers, previous_state, previous_tree, previous_cookie, previous_select
  local previous_tools, tool_buffers
  local base = 'intro\nseparator\nending'
  before_each(function()
    previous_tools = require('overleaf.buffer').setup_native
    tool_buffers = {}
    require('overleaf.buffer').setup_native = function(buf) tool_buffers[#tool_buffers + 1] = buf end
    previous_select = vim.ui.select
    vim.ui.select = function(_, _, callback) callback(nil) end
    previous_cookie = require('overleaf.config').get().cookie
    previous_state = require('overleaf')._state
    previous_tree = require('overleaf.project')._project_tree
    buffers = {}
    root = vim.fn.tempname()
    vim.fn.mkdir(root, 'p')
    root = assert(uv.fs_realpath(root))
    options = {
      root = root .. '/state',
      sourceRoot = root .. '/sources',
      server = 'https://example.test',
      projectId = 'project',
      name = 'Paper',
    }
    finish(function(done) bridge.start(done) end)
    finish(function(done) sync.open_workspace(options, done) end)
  end)
  after_each(function()
    require('overleaf.buffer').setup_native = previous_tools
    vim.ui.select = previous_select
    require('overleaf.config').get().cookie = previous_cookie
    require('overleaf')._state = previous_state
    require('overleaf.project')._project_tree = previous_tree
    if sync.close_workspace then finish(function(done) sync.close_workspace(done) end) end
    bridge.stop()
    vim.wait(5000, function() return not bridge.is_running() end)
    for _, buf in ipairs(buffers) do
      if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
    end
    if root then vim.fn.delete(root, 'rf') end
  end)
  local function open(id, path, initial, extra)
    local doc = finish(
      function(done)
        sync.open_document({ id = id, path = path }, vim.tbl_extend('force', { initial = initial }, extra or {}), done)
      end
    )
    buffers[#buffers + 1] = doc.bufnr
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    assert.is_false(doc.controller.paused or false)
    return doc
  end
  local function edit(doc, value)
    vim.api.nvim_buf_set_lines(doc.bufnr, 0, -1, false, vim.split(value, '\n', { plain = true }))
    vim.bo[doc.bufnr].undolevels = vim.bo[doc.bufnr].undolevels
    doc.controller:refresh()
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
  end

  it('retains clean legacy buffers for explicit migration during cleanup', function()
    local buf = vim.api.nvim_create_buf(true, false)
    buffers[#buffers + 1] = buf
    vim.api.nvim_buf_set_name(buf, 'overleaf://legacy-only.tex')
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'legacy text without a disk copy' })
    vim.bo[buf].modified = false
    require('overleaf').cleanup_buffers()
    assert.is_true(vim.api.nvim_buf_is_loaded(buf))
    assert.are.equal('legacy text without a disk copy', text(buf))
  end)

  it('refuses mirror imports and exports without an owned workspace', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'unsaved native edit')
    finish(function(done) sync.close_workspace(done) end)
    local state = { documents = { doc = { doc_id = 'doc', path = 'main.tex', content = 'obsolete cache' } } }
    sync._sync_dir = options.sourceRoot
    sync.import_all(state)
    sync.export_all(state)
    sync._sync_dir = nil
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    assert.are.equal('unsaved native edit', text(doc.bufnr))
  end)

  for _, kind in ipairs({ 'file', 'buffer' }) do
    it('migrates a selected legacy ' .. kind .. ' as a separate branch while retaining both originals', function()
      local doc = open('doc', 'main.tex', { content = base, version = 1 })
      vim.bo[doc.bufnr].fixendofline = false
      edit(doc, 'CURRENT UNSAVED ' .. base)
      local tree = vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree)
      require('overleaf.project')._project_tree = { { id = 'doc', path = 'main.tex', type = 'doc' } }
      local legacy = root .. '/Old Paper'
      vim.fn.mkdir(legacy, 'p')
      vim.fn.writefile({ 'independent legacy edit' }, legacy .. '/main.tex', 'b')
      local old_buf
      if kind == 'buffer' then
        old_buf = vim.api.nvim_create_buf(true, false)
        buffers[#buffers + 1] = old_buf
        vim.api.nvim_buf_set_name(old_buf, 'overleaf://main.tex')
        vim.bo[old_buf].endofline, vim.bo[old_buf].fixendofline = false, false
        vim.api.nvim_buf_set_lines(old_buf, 0, -1, false, { 'independent legacy edit' })
      end
      local selected = 0
      vim.ui.select = function(items, opts, callback)
        selected = selected + 1
        if selected == 1 then
          for _, item in ipairs(items) do
            if item.kind == kind then
              callback(item)
              return
            end
          end
          error('Legacy source missing from inventory')
        end
        assert.is_truthy(opts.prompt:find('project', 1, true))
        callback(items[1])
      end
      finish(function(done) require('overleaf').migrate(kind == 'file' and legacy or nil, done) end)
      assert.are.equal(2, selected)
      local state =
        rpc('syncDocument', { session = sync._workspace.session, document = 'doc', action = 'snapshot' }).result
      assert.are.equal('migration', state.conflict.kind)
      assert.are.equal('independent legacy edit', state.recovery.migration.content)
      assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
      assert.are.equal('CURRENT UNSAVED ' .. base, text(doc.bufnr))
      assert.are.same(tree, vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree))
      assert.are.equal('independent legacy edit', read(legacy .. '/main.tex'))
      if old_buf then
        assert.is_true(vim.api.nvim_buf_is_loaded(old_buf))
        assert.are.equal('overleaf://main.tex', vim.api.nvim_buf_get_name(old_buf))
        assert.are.equal('independent legacy edit', text(old_buf))
      end
    end)
  end

  it('keeps a deleted source as an ordinary local file with dirty text and undo intact', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'UNSAVED ' .. base)
    local tree = vim.fn.undotree()
    rpc('syncProject', { session = sync._workspace.session, project = { name = 'Paper', tree = {} } })
    doc.controller:refresh()
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    require('overleaf')._state = { connected = false, documents = sync._workspace.documents }
    local view = require('overleaf').resolve()
    assert.is_not_nil(view)
    view:accept()
    assert.are.equal('local-only', doc.controller.state.publication)
    assert.is_false(doc.connected)
    assert.are.equal('UNSAVED ' .. base, text(doc.bufnr))
    assert.same(tree, vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    view:close()
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('undo | redo | write') end)
    assert.are.equal('UNSAVED ' .. base, read(options.sourceRoot .. '/main.tex'))
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    assert.are.equal('local-only', doc.controller.state.publication)
  end)

  it('archives an old generation with its dirty buffer and opens the replacement as an independent branch', function()
    local doc = open('old', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'OLD UNSAVED ' .. base)
    rpc('syncProject', {
      session = sync._workspace.session,
      project = {
        name = 'Paper',
        tree = { { id = 'new', type = 'doc', path = 'main.tex' } },
      },
    })
    doc.controller:refresh()
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    require('overleaf')._state = { connected = false, documents = sync._workspace.documents }
    local view = require('overleaf').resolve()
    assert.is_not_nil(view)
    view:archive()
    view:close()
    assert.are_not.equal('main.tex', doc.path)
    assert.are.equal('local-only', doc.controller.state.publication)
    assert.are.equal('OLD UNSAVED ' .. base, text(doc.bufnr))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    local fresh = open('new', 'main.tex', { content = 'NEW REMOTE', version = 1 })
    assert.are_not.equal(doc.bufnr, fresh.bufnr)
    assert.are.equal(base, text(fresh.bufnr))
    assert.are.equal('NEW REMOTE', fresh.controller.state.conflict.inputs.remote)
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    assert.are.equal('OLD UNSAVED ' .. base, read(options.sourceRoot .. '/' .. doc.path))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
  end)

  it('reviews binary renames through the binary lifecycle view and retains the old bytes', function()
    local context = sync._workspace
    context.assets.image = rpc(
      'syncAsset',
      { session = context.session, document = 'image', path = 'plot.png', bytes = vim.base64.encode('binary bytes') }
    )
    rpc('syncProject', {
      session = context.session,
      project = {
        name = 'Paper',
        tree = {
          { id = 'image', type = 'file', path = 'figures/new.png' },
        },
      },
    })
    local renamed = rpc('syncAsset', { session = context.session, document = 'image', path = 'plot.png' })
    context.assets.image = renamed
    local review =
      require('overleaf.conflicts').asset(renamed, { on_resolved = function(reply) context.assets.image = reply end })
    review:accept('rename')
    assert.are.equal('figures/new.png', context.assets.image.state.path)
    assert.are.equal('binary bytes', read(options.sourceRoot .. '/plot.png'))
    assert.are.equal('binary bytes', read(options.sourceRoot .. '/figures/new.png'))
    review:close()
  end)

  it('recovers a lost binary rename reply by inspecting the committed identity', function()
    local context = sync._workspace
    rpc(
      'syncAsset',
      { session = context.session, document = 'image', path = 'plot.png', bytes = vim.base64.encode('binary bytes') }
    )
    rpc('syncProject', {
      session = context.session,
      project = { name = 'Paper', tree = { { id = 'image', type = 'file', path = 'new.png' } } },
    })
    local asset = rpc('syncAsset', { session = context.session, document = 'image', path = 'plot.png' })
    local request, copies = bridge.request, 0
    local view = require('overleaf.conflicts').asset(asset, {
      request = function(method, fields, callback)
        if method == 'syncAssetLifecycle' and fields.action == 'rename' then
          copies = copies + 1
          request(method, fields, function(err)
            assert.is_nil(err)
            callback({ code = 'TIMEOUT', message = 'Lost reply' })
          end)
        else
          request(method, fields, callback)
        end
      end,
    })
    local receipt = view:accept('rename')
    assert.are.equal('new.png', receipt.state.path)
    assert.are.equal(1, copies)
    assert.are.equal('binary bytes', read(options.sourceRoot .. '/new.png'))
    view:close()
  end)

  it('reopening a cached tree exposes deleted sources and renamed assets for review', function()
    open('old', 'main.tex', { content = base, version = 1 })
    rpc('syncAsset', {
      session = sync._workspace.session,
      document = 'image',
      path = 'plot.png',
      bytes = vim.base64.encode('binary bytes'),
    })
    local tree = { { id = 'image', type = 'file', path = 'renamed.png' } }
    rpc('syncProject', { session = sync._workspace.session, project = { name = 'Paper', tree = tree } })
    finish(function(done) sync.close_workspace(done) end)
    finish(function(done) sync.open_workspace(options, done) end)
    finish(function(done) sync.sync_tree(tree, done) end)
    assert.are.equal('remote-deleted', sync._workspace.documents.old.state.lifecycle.reason)
    assert.are.equal('remote-renamed', sync._workspace.assets.image.state.lifecycle.reason)
    assert.are.equal('plot.png', sync._workspace.assets.image.state.path)
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    assert.are.equal('binary bytes', read(options.sourceRoot .. '/plot.png'))
    assert.is_nil(uv.fs_stat(options.sourceRoot .. '/renamed.png'))
  end)

  it(
    'renders server comment ranges in a dirty Unicode buffer and finds the thread at its native byte column',
    function()
      local wire = 'é😀 abc'
      local doc = open('doc', 'main.tex', { content = wire, version = 1 })
      require('overleaf')._state = { connected = true, documents = sync._workspace.documents }
      rpc('syncDocument', {
        session = sync._workspace.session,
        document = 'doc',
        action = 'remote',
        remote = {
          content = wire,
          wire = wire,
          wireBom = false,
          format = { fileformat = 'unix', bomb = false },
          version = 2,
          comments = { { id = 'thread', op = { p = 4, c = 'abc', t = 'thread' } } },
        },
      })
      edit(doc, 'UNSAVED ' .. wire)
      local comments = require('overleaf.comments')
      comments._threads = { thread = { id = 'thread', messages = { { content = 'Review this' } }, resolved = false } }
      finish(function(done) comments.refresh_document(doc, done) end)
      local diagnostics = vim.diagnostic.get(doc.bufnr, { namespace = comments._diag_ns })
      assert.are.equal(1, #diagnostics)
      assert.are.equal(15, diagnostics[1].col)
      assert.are.equal(18, diagnostics[1].end_col)
      vim.api.nvim_win_set_cursor(0, { 1, 16 })
      assert.are.equal('thread', comments.get_thread_at_cursor('doc').id)
      assert.are.equal(wire, read(options.sourceRoot .. '/main.tex'))
      assert.are.equal('UNSAVED ' .. wire, text(doc.bufnr))
      edit(doc, 'MORE UNSAVED ' .. wire)
      assert.is_true(vim.wait(5000, function()
        local current = vim.diagnostic.get(doc.bufnr, { namespace = comments._diag_ns })
        return #current == 1 and current[1].col == 20
      end))
      comments.on_delete_thread({ threadId = 'thread' })
      finish(function(done) comments.refresh_document(doc, done) end)
      assert.are.equal(0, #vim.diagnostic.get(doc.bufnr, { namespace = comments._diag_ns }))
      comments.clear_all()
    end
  )

  it('refreshes all owned comment ranges without joining or leaving documents', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    local comments = require('overleaf.comments')
    local project = require('overleaf.project')
    project._project_tree = { { id = 'doc', path = 'main.tex', type = 'doc' } }
    require('overleaf')._state = { connected = true, documents = sync._workspace.documents }
    local original, methods = bridge.request, {}
    bridge.request = function(method, params, callback)
      methods[#methods + 1] = method
      if method == 'getThreads' then
        callback(nil, {})
      else
        original(method, params, callback)
      end
    end
    local ok, problem = pcall(function()
      local result = finish(function(done) comments.refresh_project_comments('project', done) end)
      assert.are.equal(0, result.failed)
      assert.is_false(vim.tbl_contains(methods, 'joinDoc'))
      assert.is_false(vim.tbl_contains(methods, 'leaveDoc'))
      assert.is_true(vim.tbl_contains(methods, 'syncDocument'))
      assert.are.equal(base, text(doc.bufnr))
    end)
    bridge.request = original
    assert.is_true(ok, tostring(problem))
  end)

  it('searches owned dirty and background documents without network requests or source writes', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'UNSAVED needle')
    finish(
      function(done)
        sync.open_document(
          { id = 'background', path = 'other.tex' },
          { background = true, initial = { content = 'saved needle', version = 1 } },
          done
        )
      end
    )
    require('overleaf.project')._project_tree = {
      { id = 'doc', path = 'main.tex', type = 'doc' },
      { id = 'background', path = 'other.tex', type = 'doc' },
      { id = 'unavailable', path = 'missing.tex', type = 'doc' },
    }
    local picker = require('overleaf.picker')
    local original, request, picked = picker.locations, bridge.request, nil
    picker.locations = function(_, locations) picked = locations end
    bridge.request = function() error('Search must not make network requests') end
    local ok, problem = pcall(function()
      require('overleaf.search').grep('needle', { documents = {} })
      assert.is_true(vim.wait(1000, function() return picked ~= nil end))
      assert.are.equal(2, #picked)
      assert.are.equal('UNSAVED needle', picked[1].text)
      assert.are.equal('saved needle', picked[2].text)
      assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
      assert.is_nil(uv.fs_stat(options.sourceRoot .. '/missing.tex'))
    end)
    picker.locations, bridge.request = original, request
    assert.is_true(ok, tostring(problem))
  end)

  it('maps collaborator cursors through dirty Unicode text using complete native byte columns', function()
    local wire = 'é😀 abc'
    local doc = open('doc', 'main.tex', { content = wire, version = 1 })
    require('overleaf')._state = { connected = true, documents = sync._workspace.documents }
    rpc('syncDocument', {
      session = sync._workspace.session,
      document = 'doc',
      action = 'remote',
      remote = {
        content = wire,
        wire = wire,
        wireBom = false,
        format = { fileformat = 'unix', bomb = false },
        version = 2,
      },
    })
    edit(doc, 'UNSAVED ' .. wire)
    local cursors = require('overleaf.cursors')
    cursors.on_client_updated({ id = 'peer', doc_id = 'doc', row = 0, column = 1, name = 'Peer' })
    local mark
    assert.is_true(vim.wait(5000, function()
      mark =
        vim.api.nvim_buf_get_extmark_by_id(doc.bufnr, cursors._ns, cursors._get_mark_id('peer'), { details = true })
      return #mark > 0 and mark[2] == 10
    end))
    assert.are.equal(14, mark[3].end_col)
    assert.are.equal('UNSAVED ' .. wire, text(doc.bufnr))
    assert.are.equal(wire, read(options.sourceRoot .. '/main.tex'))
    cursors.clear_all()
  end)

  it('ignores a comment-thread response after switching projects', function()
    local comments = require('overleaf.comments')
    local original, delayed = bridge.request, nil
    local failure
    bridge.request = function(method, params, callback)
      if method == 'getThreads' then
        delayed = callback
      else
        original(method, params, callback)
      end
    end
    local ok, problem = pcall(function()
      comments.load_threads('project', function(err) failure = err end)
      finish(
        function(done)
          sync.open_workspace(
            vim.tbl_extend('force', options, { projectId = 'next', sourceRoot = root .. '/next' }),
            done
          )
        end
      )
      comments._threads = { current = { id = 'current', messages = {} } }
      delayed(nil, { old = { messages = { { content = 'old project' } } } })
      assert.are.equal('SESSION_CLOSED', failure.code)
      assert.is_not_nil(comments._threads.current)
      assert.is_nil(comments._threads.old)
    end)
    bridge.request = original
    assert.is_true(ok, tostring(problem))
  end)

  it('rejects stale feature projections after typing without advancing the editor revision', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    local original, delayed, result, failure = bridge.request, nil, nil, nil
    bridge.request = function(method, params, callback)
      if method == 'syncDocument' and params.action == 'features' and params.cursor then
        original(method, params, function(err, reply)
          delayed = function() callback(err, reply) end
        end)
      else
        original(method, params, callback)
      end
    end
    local called, problem = pcall(function()
      sync.project_features(doc, { cursor = { row = 0, column = 0 } }, function(err, reply)
        failure, result = err, reply
      end)
      assert.is_true(vim.wait(5000, function() return delayed ~= nil end))
      vim.api.nvim_buf_set_lines(doc.bufnr, 0, -1, false, { 'new typing' })
      local revision = doc.controller.revision
      delayed()
      assert.are.equal('STALE_VIEW', failure.code)
      assert.is_nil(result)
      assert.are.equal(revision, doc.controller.revision)
    end)
    bridge.request = original
    assert.is_true(called, tostring(problem))
  end)

  it('accepts a remote rename without changing dirty text or its native undo tree', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'UNSAVED ' .. base)
    local tree = vim.fn.undotree()
    rpc('syncProject', {
      session = sync._workspace.session,
      project = {
        name = 'Paper',
        tree = { { id = 'doc', type = 'doc', path = 'chapters/new.tex' } },
      },
    })
    doc.controller:refresh()
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    require('overleaf')._state = { connected = false, documents = sync._workspace.documents }
    local view = require('overleaf').resolve()
    assert.is_not_nil(view)
    view:accept()
    assert.are.equal('chapters/new.tex', doc.path)
    assert.are.equal(options.sourceRoot .. '/chapters/new.tex', vim.api.nvim_buf_get_name(doc.bufnr))
    assert.are.equal('UNSAVED ' .. base, text(doc.bufnr))
    assert.same(tree, vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree))
    assert.is_true(vim.bo[doc.bufnr].modified)
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    assert.are.equal(base, read(options.sourceRoot .. '/chapters/new.tex'))
    view:close()
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('undo') end)
    assert.are.equal(base, text(doc.bufnr))
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('redo | write') end)
    assert.are.equal('UNSAVED ' .. base, read(options.sourceRoot .. '/chapters/new.tex'))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    assert.are.equal('doc', sync._workspace.by_path['chapters/new.tex'])
    assert.is_nil(sync._workspace.by_path['main.tex'])
  end)

  it('recovers a lost relocation reply from the committed path without repeating the copy', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'UNSAVED ' .. base)
    rpc('syncProject', {
      session = sync._workspace.session,
      project = {
        name = 'Paper',
        tree = { { id = 'doc', type = 'doc', path = 'new.tex' } },
      },
    })
    local review = doc.controller:review_relocation()
    local request = doc.controller.request
    local copies = 0
    doc.controller.request = function(method, params, callback)
      if params.action == 'relocate' then
        copies = copies + 1
        request(method, params, function(err)
          assert.is_nil(err)
          callback({ code = 'TIMEOUT', message = 'Lost reply' })
        end)
      else
        request(method, params, callback)
      end
    end
    sync.relocate_document(doc, review)
    assert.are.equal(1, copies)
    assert.are.equal('new.tex', doc.path)
    assert.are.equal('UNSAVED ' .. base, text(doc.bufnr))
    assert.are.equal(base, read(options.sourceRoot .. '/new.tex'))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
  end)

  it('refuses relocation into an independently open buffer', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    rpc('syncProject', {
      session = sync._workspace.session,
      project = {
        name = 'Paper',
        tree = { { id = 'doc', type = 'doc', path = 'new.tex' } },
      },
    })
    local target = vim.fn.bufadd(options.sourceRoot .. '/new.tex')
    vim.fn.bufload(target)
    buffers[#buffers + 1] = target
    vim.api.nvim_buf_set_lines(target, 0, -1, false, { 'independent' })
    local review = doc.controller:review_relocation()
    assert.has_error(function() doc.controller:relocate(review) end)
    assert.are.equal('independent', text(target))
    assert.are.equal('main.tex', doc.path)
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    assert.is_nil(uv.fs_stat(options.sourceRoot .. '/new.tex'))
  end)

  it('opens an ordinary nested file and saves locally while offline without publishing newer unsaved text', function()
    local doc = open('doc', 'chapters/main.tex', { content = base, version = 1 })
    assert.are.equal(options.sourceRoot .. '/chapters/main.tex', vim.api.nvim_buf_get_name(doc.bufnr))
    assert.are.equal('', vim.bo[doc.bufnr].buftype)
    assert.are.equal(base, read(vim.api.nvim_buf_get_name(doc.bufnr)))
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'SAVED ' .. base)
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    edit(doc, 'UNSAVED ' .. base)
    assert.are.equal('SAVED ' .. base, read(vim.api.nvim_buf_get_name(doc.bufnr)))
    local state =
      rpc('syncDocument', { session = doc.controller.session, document = 'doc', action = 'snapshot' }).result
    assert.are.equal('SAVED ' .. base, state.saved)
    assert.are.equal('UNSAVED ' .. base, state.buffer)
    assert.are.equal(base, state.remote.content)
    assert.is_true(vim.bo[doc.bufnr].modified)
  end)

  it('keeps an existing independent source and opens its conflict without replacing local bytes', function()
    local filename = options.sourceRoot .. '/main.tex'
    local file = assert(io.open(filename, 'wb'))
    assert(file:write('independent local source'))
    assert(file:close())
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    assert.are.equal('independent local source', read(filename))
    assert.are.equal('independent local source', text(doc.bufnr))
    local state = rpc('syncDocument', { session = doc.controller.session, document = 'doc', action = 'state' }).state
    assert.are.equal('missing-base', state.conflict.reason)
  end)

  it('redirects import and export commands to reconciliation without publishing unsaved text', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'UNSAVED ' .. base)
    local obsolete = { doc_id = 'doc', path = 'main.tex', content = 'obsolete mirror', bufnr = doc.bufnr }
    sync.export_all({ documents = { doc = obsolete } })
    sync.import_all({ documents = { doc = obsolete } })
    finish(function(done) sync.sync_all({ documents = { doc = obsolete } }, {}, done) end)
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    assert.are.equal(base, read(vim.api.nvim_buf_get_name(doc.bufnr)))
    assert.are.equal('UNSAVED ' .. base, text(doc.bufnr))
    assert.is_true(vim.bo[doc.bufnr].modified)
  end)

  it('receives an independent remote edit while preserving dirty text and local-only undo', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'MY ' .. base)
    rpc('syncDocument', {
      session = doc.controller.session,
      document = 'doc',
      action = 'remote',
      remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 },
    })
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    assert.are.equal('MY ' .. base:gsub('ending', 'THEIR ending'), text(doc.bufnr))
    assert.are.equal(base:gsub('ending', 'THEIR ending'), read(vim.api.nvim_buf_get_name(doc.bufnr)))
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('silent undo') end)
    assert.are.equal(base:gsub('ending', 'THEIR ending'), text(doc.bufnr))
  end)

  it('switches projects without deleting or reusing the old project dirty buffer', function()
    local first = open('doc', 'main.tex', { content = base, version = 1 })
    edit(first, 'UNSAVED ' .. base)
    local before = vim.api.nvim_buf_call(first.bufnr, vim.fn.undotree)
    local other = vim.tbl_extend('force', options, { projectId = 'other', sourceRoot = root .. '/other-sources' })
    finish(function(done) sync.open_workspace(other, done) end)
    local second = open('doc', 'main.tex', { content = 'other project', version = 1 })
    assert.are_not.equal(first.bufnr, second.bufnr)
    assert.are.equal('UNSAVED ' .. base, text(first.bufnr))
    assert.are.same(before, vim.api.nvim_buf_call(first.bufnr, vim.fn.undotree))
    assert.is_true(vim.bo[first.bufnr].modified)
    assert.is_true(first.controller.stopped)
    assert.are.equal('other project', text(second.bufnr))
  end)

  it('reopens a known source offline and explicitly restores its archived unsaved text and undo', function()
    local first = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[first.bufnr].fixendofline = false
    edit(first, 'RECOVER ' .. base)
    finish(function(done) sync.close_workspace(done) end)
    vim.api.nvim_buf_delete(first.bufnr, { force = true }) -- Simulate losing only this disposable process's live buffer.
    finish(function(done) sync.open_workspace(options, done) end)
    local second = open('doc', 'main.tex', nil, { recovery = 'restore' })
    assert.are.equal('RECOVER ' .. base, text(second.bufnr))
    assert.are.equal(base, read(vim.api.nvim_buf_get_name(second.bufnr)))
    vim.api.nvim_buf_call(second.bufnr, function() vim.cmd('silent undo') end)
    assert.are.equal(base, text(second.bufnr))
  end)

  it('ignores an old document open reply after switching project ownership', function()
    local original, delayed, failure, opened = bridge.request, nil, nil, nil
    bridge.request = function(method, params, callback)
      original(method, params, function(err, reply)
        if method == 'syncDocument' and params.action == 'open' and params.document == 'late' then
          delayed = function() callback(err, reply) end
        else
          callback(err, reply)
        end
      end)
    end
    local ok, err = pcall(function()
      sync.open_document(
        { id = 'late', path = 'old.tex' },
        { initial = { content = 'old project', version = 1 } },
        function(e, doc)
          failure, opened = e, doc
        end
      )
      assert.is_true(vim.wait(10000, function() return delayed ~= nil end))
      local other = vim.tbl_extend('force', options, { projectId = 'other', sourceRoot = root .. '/other-sources' })
      finish(function(done) sync.open_workspace(other, done) end)
      local current = open('current', 'new.tex', { content = 'current project', version = 1 })
      delayed()
      assert.are.equal('SESSION_CLOSED', failure.code)
      assert.is_nil(opened)
      assert.are.equal(current.bufnr, vim.api.nvim_get_current_buf())
      assert.are.equal('current project', text(current.bufnr))
    end)
    bridge.request = original
    assert.is_true(ok, tostring(err))
  end)

  it('keeps a buffer already being edited as an independent branch with its full native history', function()
    local filename = options.sourceRoot .. '/main.tex'
    local file = assert(io.open(filename, 'wb'))
    assert(file:write(base))
    assert(file:close())
    local buf = vim.fn.bufadd(filename)
    vim.fn.bufload(buf)
    buffers[#buffers + 1] = buf
    vim.api.nvim_buf_set_lines(buf, 0, 1, false, { 'already editing' })
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    local before = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    assert.are.equal(buf, doc.bufnr)
    assert.are.equal('already editing\nseparator\nending', text(buf))
    assert.are.same(before, vim.api.nvim_buf_call(buf, vim.fn.undotree))
    assert.are.equal(base, read(filename))
    assert.are.equal(
      'missing-base',
      rpc('syncDocument', { session = doc.controller.session, document = 'doc', action = 'state' }).state.conflict.reason
    )
  end)

  it('can keep the current file after restart while retaining the archived unsaved branch for recovery', function()
    local first = open('doc', 'main.tex', { content = base, version = 1 })
    edit(first, 'ARCHIVED ' .. base)
    finish(function(done) sync.close_workspace(done) end)
    vim.api.nvim_buf_delete(first.bufnr, { force = true })
    finish(function(done) sync.open_workspace(options, done) end)
    local second = open('doc', 'main.tex', nil, { recovery = 'current' })
    assert.are.equal(base, text(second.bufnr))
    assert.are.equal(base, read(vim.api.nvim_buf_get_name(second.bufnr)))
    local state =
      rpc('syncDocument', { session = second.controller.session, document = 'doc', action = 'snapshot' }).result
    assert.are.equal('ARCHIVED ' .. base, state.recovery.editorChoice.buffer)
    assert.are.equal(base, state.saved)
  end)

  it('coalesces overlapping opens without attaching two owners or reinterpreting a changed caller table', function()
    local entry = { id = 'doc', path = 'main.tex' }
    local results, failures = {}, {}
    for index = 1, 2 do
      sync.open_document(entry, { initial = { content = base, version = 1 } }, function(err, doc)
        if err then
          failures[#failures + 1] = err
        else
          results[index] = doc
        end
      end)
    end
    entry.id, entry.path = 'other', '../outside.tex'
    assert.is_true(vim.wait(10000, function() return #failures > 0 or #results == 2 end))
    assert.are.same({}, failures)
    buffers[#buffers + 1] = results[1].bufnr
    assert.are.equal(results[1], results[2])
    assert.is_true(vim.wait(10000, function() return results[1].controller:idle() end))
    assert.are.equal(options.sourceRoot .. '/main.tex', vim.api.nvim_buf_get_name(results[1].bufnr))
    local error
    sync.open_document({ id = 'doc', path = 'renamed.tex' }, {}, function(err) error = err end)
    assert.are.equal('PATH_BOUND', error.code)
    assert.is_nil(uv.fs_stat(options.sourceRoot .. '/renamed.tex'))
  end)

  it('synchronizes unopened sources without creating or displaying editor buffers', function()
    local current = vim.api.nvim_get_current_buf()
    local filename = options.sourceRoot .. '/background.tex'
    local doc = finish(
      function(done)
        sync.open_document({ id = 'background', path = 'background.tex' }, {
          background = true,
          initial = { content = base, version = 1 },
        }, done)
      end
    )
    assert.is_nil(doc.bufnr)
    assert.are.equal(-1, vim.fn.bufnr(filename))
    assert.are.equal(current, vim.api.nvim_get_current_buf())
    rpc('syncDocument', {
      session = sync._workspace.session,
      document = 'background',
      action = 'remote',
      remote = { content = 'REMOTE ' .. base, version = 2 },
    })
    finish(function(done) sync.reconcile(done) end)
    assert.are.equal('REMOTE ' .. base, read(filename))
    assert.are.equal(-1, vim.fn.bufnr(filename))
    local opened = open('background', 'background.tex')
    assert.are.equal('REMOTE ' .. base, text(opened.bufnr))
  end)

  it('updates a closed source and its persistent undo without restoring archived unsaved text', function()
    local first = open('doc', 'main.tex', { content = base, version = 1 })
    local old_undodir = vim.o.undodir
    local ok, failure = pcall(function()
      vim.o.undodir = '.'
      vim.bo[first.bufnr].undofile = true
      vim.bo[first.bufnr].fixendofline = false
      edit(first, 'SAVED ' .. base)
      vim.api.nvim_buf_call(first.bufnr, function() vim.cmd('write') end)
      edit(first, 'UNSAVED ' .. base)
      finish(function(done) sync.close_workspace(done) end)
      vim.api.nvim_buf_delete(first.bufnr, { force = true })
      finish(function(done) sync.open_workspace(options, done) end)
      local doc = finish(
        function(done)
          sync.open_document({ id = 'doc', path = 'main.tex' }, { background = true, recovery = 'restore' }, done)
        end
      )
      assert.is_nil(doc.bufnr)
      rpc('syncDocument', {
        session = sync._workspace.session,
        document = 'doc',
        action = 'remote',
        remote = { content = base:gsub('ending', 'THEIR ending'), version = 2 },
      })
      finish(function(done) sync.reconcile(done) end)
      local filename = options.sourceRoot .. '/main.tex'
      assert.are.equal('SAVED ' .. base:gsub('ending', 'THEIR ending'), read(filename))
      local buf = vim.fn.bufadd(filename)
      buffers[#buffers + 1] = buf
      vim.bo[buf].undofile = true
      vim.fn.bufload(buf)
      vim.api.nvim_buf_call(buf, function() vim.cmd('silent undo') end)
      assert.are.equal(base:gsub('ending', 'THEIR ending'), text(buf))
      local state =
        rpc('syncDocument', { session = sync._workspace.session, document = 'doc', action = 'snapshot' }).result
      local archived
      for _, node in ipairs(state.editor.checkpoint.history.nodes) do
        if node.seq == state.editor.checkpoint.history.current then archived = node.content end
      end
      assert.are.equal('UNSAVED ' .. base, archived)
    end)
    vim.o.undodir = old_undodir
    assert.is_true(ok, tostring(failure))
  end)

  it('opens cached files through the public command while offline and preserves guarded saves', function()
    finish(
      function(done)
        sync.open_document({ id = 'doc', path = 'main.tex' }, {
          background = true,
          initial = { content = base, version = 1 },
        }, done)
      end
    )
    local overleaf = require('overleaf')
    overleaf._state = { connected = false, project_id = 'project', documents = sync._workspace.documents }
    overleaf.open_document('doc', 'main.tex')
    local doc = sync._workspace.documents.doc
    assert.is_true(vim.wait(10000, function() return doc.controller ~= nil end))
    buffers[#buffers + 1] = doc.bufnr
    assert.are.equal(doc.bufnr, vim.api.nvim_get_current_buf())
    assert.are.equal(options.sourceRoot .. '/main.tex', vim.api.nvim_buf_get_name(doc.bufnr))
    assert.is_true(vim.wait(10000, function() return doc.controller:idle() end))
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'SAVED ' .. base)
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    assert.are.equal('SAVED ' .. base, read(options.sourceRoot .. '/main.tex'))
    assert.are.equal('offline', doc.controller.state.transport.state)
  end)

  it('disconnects the network while retaining native buffers and local save ownership', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    local overleaf = require('overleaf')
    overleaf._state = { connected = true, project_id = 'project', documents = sync._workspace.documents }
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'MY ' .. base)
    overleaf.disconnect()
    assert.is_true(bridge.is_running())
    assert.is_false(overleaf._state.connected)
    assert.are.equal(doc, overleaf._state.documents.doc)
    assert.is_false(doc.controller.stopped or false)
    assert.are.equal('MY ' .. base, text(doc.bufnr))
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    assert.are.equal('MY ' .. base, read(options.sourceRoot .. '/main.tex'))
  end)

  it('keeps workspace listeners when connection handlers are registered again', function()
    local overleaf = require('overleaf')
    overleaf._state = { connected = false, project_id = 'project', documents = sync._workspace.documents }
    local listener = sync._workspace.changed
    overleaf._setup_event_handlers()
    overleaf._setup_event_handlers()
    assert.is_true(vim.tbl_contains(bridge._event_handlers.syncChanged or {}, listener))
  end)

  it('reconciles the project tree with background documents and guarded binary assets', function()
    local previous_request = bridge.request
    bridge.request = function(method, params, callback)
      if method == 'joinDoc' then
        callback(nil, { lines = vim.split(base, '\n'), version = 1 })
      elseif method == 'syncConnect' then
        callback(nil, { transport = { state = 'idle' } })
      elseif method == 'syncFetchAsset' then
        previous_request('syncAsset', {
          session = params.session,
          document = params.document,
          path = params.path,
          bytes = vim.base64.encode('\0\255image'),
        }, callback)
      else
        previous_request(method, params, callback)
      end
    end
    local ok, failure = pcall(function()
      sync._workspace.connected = true
      local tree = {
        { id = 'folder', path = 'chapters/', type = 'folder' },
        { id = 'doc', path = 'chapters/main.tex', type = 'doc' },
        { id = 'image', path = 'plot.png', type = 'file' },
      }
      local current = vim.api.nvim_get_current_buf()
      finish(function(done) sync.sync_tree(tree, done) end)
      assert.are.equal(base, read(options.sourceRoot .. '/chapters/main.tex'))
      assert.are.equal('\0\255image', read(options.sourceRoot .. '/plot.png'))
      assert.are.equal(current, vim.api.nvim_get_current_buf())
      assert.is_nil(sync._workspace.documents.doc.bufnr)
      assert.are.equal('synced', sync._workspace.assets.image.state.status)
      finish(function(done) sync.close_workspace(done) end)
      finish(function(done) sync.open_workspace(options, done) end)
      finish(function(done) sync.sync_tree(tree, done) end)
      assert.are.equal('synced', sync._workspace.assets.image.state.status)
      assert.is_nil(sync._workspace.sources.image)
    end)
    bridge.request = previous_request
    assert.is_true(ok, tostring(failure))
  end)

  it('connects a project through durable ordinary sources and retains the prior dirty buffer', function()
    local first = open('old', 'old.tex', { content = base, version = 1 })
    edit(first, 'KEEP ' .. base)
    local overleaf = require('overleaf')
    overleaf._state = { connected = false, project_id = 'project', documents = sync._workspace.documents }
    local old_request, old_open, old_explorer = bridge.request, sync.open_workspace, overleaf.open_explorer
    local opened_explorer, connected_with_token = false, nil
    overleaf.open_explorer = function() opened_explorer = true end
    sync.open_workspace = function(params, callback)
      old_open(
        vim.tbl_extend('force', params, { root = root .. '/state', sourceRoot = root .. '/next-project' }),
        callback
      )
    end
    bridge.request = function(method, params, callback)
      if method == 'auth' then
        callback(nil, { csrfToken = 'cached-auth-token', userId = 'fixture-user', projects = {} })
      elseif method == 'connect' then
        connected_with_token = overleaf._state.csrf_token
        callback(nil, { project = { rootFolder = { docs = { { _id = 'new', name = 'main.tex' } } } } })
      elseif method == 'joinDoc' then
        callback(nil, { lines = { 'new project' }, version = 1 })
      elseif method == 'syncConnect' then
        callback(nil, { transport = { state = 'idle' } })
      elseif method == 'getThreads' then
        callback(nil, {})
      else
        old_request(method, params, callback)
      end
    end
    local ok, failure = pcall(function()
      overleaf._connect_project('test-cookie', 'next-project', 'Next project')
      assert.is_true(vim.wait(10000, function() return opened_explorer end))
      assert.are.equal('KEEP ' .. base, text(first.bufnr))
      assert.is_true(vim.bo[first.bufnr].modified)
      assert.are.equal('cached-auth-token', connected_with_token)
      assert.are.equal('next-project', sync._workspace.params.projectId)
      assert.are.equal('new project', read(root .. '/next-project/main.tex'))
      assert.are.equal(sync._workspace.documents, overleaf._state.documents)
      local metadata = rpc('syncProject', { session = sync._workspace.session }).project
      assert.are.equal('Next project', metadata.name)
      assert.are.equal('main.tex', metadata.tree[1].path)
    end)
    bridge.request, sync.open_workspace, overleaf.open_explorer = old_request, old_open, old_explorer
    assert.is_true(ok, tostring(failure))
  end)

  it('offers cached projects before authentication and opens their recorded sources offline', function()
    open('doc', 'main.tex', { content = base, version = 1 })
    rpc('syncProject', {
      session = sync._workspace.session,
      project = {
        name = 'Cached paper',
        tree = { { id = 'doc', path = 'main.tex', type = 'doc' } },
      },
    })
    finish(function(done) sync.close_workspace(done) end)
    local overleaf, picker = require('overleaf'), require('overleaf.picker')
    local old_request, old_select, old_explorer = bridge.request, picker.select, overleaf.open_explorer
    local old_projects = require('overleaf.project')._projects
    require('overleaf.project')._projects = {}
    overleaf._state = { connected = false, documents = {} }
    require('overleaf.config').get().cookie = nil
    local shown, opened, network = false, false, false
    bridge.request = function(method, params, callback)
      if method == 'syncListProjects' then
        params = { root = options.root, server = options.server }
      elseif method == 'syncLocate' or method == 'syncOpen' then
        params.root, params.server = options.root, options.server
      elseif method == 'connect' or method == 'listBrowserProfiles' then
        network = true
        callback({ message = 'No network available' })
        return
      end
      old_request(method, params, callback)
    end
    picker.select = function(items, _, callback)
      shown = true
      assert.are.equal('Cached paper', items[1].name)
      assert.are.equal(options.sourceRoot, items[1].sourceRoot)
      callback(items[1])
    end
    overleaf.open_explorer = function() opened = true end
    local ok, failure = pcall(function()
      overleaf.projects()
      assert.is_true(vim.wait(10000, function() return opened end))
      assert.is_true(shown)
      assert.is_false(network)
      assert.is_false(sync._workspace.connected)
      assert.are.equal(options.sourceRoot, sync._workspace.root)
      assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
      assert.is_truthy(sync._workspace.documents.doc)
    end)
    bridge.request, picker.select, overleaf.open_explorer = old_request, old_select, old_explorer
    require('overleaf.project')._projects = old_projects
    assert.is_true(ok, tostring(failure))
  end)

  it('opens the native explorer for an offline workspace', function()
    local tree = require('overleaf.tree')
    local old_toggle, old_explorer = tree.toggle, require('overleaf.config').get().explorer
    local opened = false
    tree.toggle = function() opened = true end
    require('overleaf.config').get().explorer = 'native'
    require('overleaf')._state = { connected = false, documents = sync._workspace.documents }
    local ok, failure = pcall(require('overleaf.explorer').open)
    tree.toggle, require('overleaf.config').get().explorer = old_toggle, old_explorer
    assert.is_true(ok, tostring(failure))
    assert.is_true(opened)
  end)

  it('remote delete retains the local file and unsaved buffer with a visible lifecycle hold', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'KEEP ' .. base)
    local overleaf, project = require('overleaf'), require('overleaf.project')
    overleaf._state =
      { connected = true, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    project._project_tree = { { id = 'doc', path = 'main.tex', name = 'main.tex', type = 'doc', depth = 0 } }
    local original = bridge.request
    bridge.request = function(method, params, callback)
      if method == 'deleteEntity' then
        callback(nil, {})
      else
        original(method, params, callback)
      end
    end
    local ok, failure = pcall(function()
      finish(function(done) require('overleaf.ops').delete('main.tex', done) end)
      assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
      assert.are.equal('KEEP ' .. base, text(doc.bufnr))
      assert.is_true(vim.bo[doc.bufnr].modified)
      assert.are.equal(
        'remote-deleted',
        rpc('syncDocument', {
          session = sync._workspace.session,
          document = 'doc',
          action = 'state',
        }).state.lifecycle.reason
      )
    end)
    bridge.request = original
    assert.is_true(ok, tostring(failure))
  end)

  it('remote restore keeps document generations separate without replacing dirty text or history', function()
    local doc = open('old', 'main.tex', { content = base, version = 1 })
    edit(doc, 'KEEP ' .. base)
    local overleaf, project = require('overleaf'), require('overleaf.project')
    overleaf._state =
      { connected = false, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    project._project_tree = { { id = 'old', path = 'main.tex', name = 'main.tex', type = 'doc', depth = 0 } }
    overleaf._setup_event_handlers()
    local before = vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree)
    for _, callback in ipairs(bridge._event_handlers.removeEntity) do
      callback({ entityId = 'old', meta = { kind = 'file-restore', path = 'main.tex' } })
    end
    for _, callback in ipairs(bridge._event_handlers.reciveNewDoc) do
      callback({ doc = { _id = 'new', name = 'main.tex' }, meta = { kind = 'file-restore', path = 'main.tex' } })
    end
    finish(function(done) overleaf._save_project_tree(done) end)
    assert.are.equal('old', doc.doc_id)
    assert.are.equal(doc, overleaf._state.documents.old)
    assert.is_nil(overleaf._state.documents.new)
    assert.are.equal('KEEP ' .. base, text(doc.bufnr))
    assert.are.same(before, vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    assert.are.equal('new', project.get_doc_by_path('main.tex').id)
    assert.are.equal(
      'remote-replaced',
      rpc('syncDocument', {
        session = sync._workspace.session,
        document = 'old',
        action = 'state',
      }).state.lifecycle.reason
    )
  end)

  it('persists remote folder moves and project names without moving a dirty native source', function()
    local doc = open('doc', 'chapter/main.tex', { content = base, version = 1 })
    edit(doc, 'KEEP ' .. base)
    local overleaf, project = require('overleaf'), require('overleaf.project')
    overleaf._state =
      { connected = false, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    project._project_tree = {
      { id = 'chapter', path = 'chapter/', name = 'chapter', type = 'folder', depth = 0 },
      { id = 'doc', path = 'chapter/main.tex', name = 'main.tex', type = 'doc', depth = 1 },
    }
    overleaf._setup_event_handlers()
    overleaf._connection_handlers.reciveNewFolder({ folder = { _id = 'parts', name = 'parts' } })
    overleaf._connection_handlers.reciveEntityMove({ entityId = 'chapter', folderId = 'parts' })
    overleaf._connection_handlers.projectNameUpdated({ name = 'Renamed paper' })
    assert.is_true(
      vim.wait(10000, function() return sync._workspace.project and sync._workspace.project.name == 'Renamed paper' end)
    )
    assert.are.equal('parts/chapter/main.tex', project.get_entry_by_id('doc').path)
    assert.are.equal(2, project.get_entry_by_id('doc').depth)
    assert.are.equal('chapter/main.tex', doc.path)
    assert.are.equal('KEEP ' .. base, text(doc.bufnr))
    assert.are.equal(base, read(options.sourceRoot .. '/chapter/main.tex'))
    assert.are.equal(
      'remote-renamed',
      rpc('syncDocument', { session = sync._workspace.session, document = 'doc', action = 'state' }).state.lifecycle.reason
    )
    assert.are.equal('Renamed paper', rpc('syncProject', { session = sync._workspace.session }).project.name)
  end)

  it('materializes newly announced sources without opening buffers', function()
    local overleaf, project = require('overleaf'), require('overleaf.project')
    overleaf._state =
      { connected = true, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    sync._workspace.connected, project._project_tree = true, {}
    local previous_request = bridge.request
    bridge.request = function(method, params, callback)
      if method == 'joinDoc' then
        callback(nil, { lines = { 'new source' }, version = 1 })
      elseif method == 'syncConnect' then
        callback(nil, { transport = { state = 'idle' } })
      else
        previous_request(method, params, callback)
      end
    end
    local ok, failure = pcall(function()
      overleaf._setup_event_handlers()
      overleaf._connection_handlers.reciveNewDoc({ doc = { _id = 'new', name = 'new.tex' } })
      assert.is_true(vim.wait(10000, function() return sync._workspace.documents.new ~= nil end))
      assert.are.equal('new source', read(options.sourceRoot .. '/new.tex'))
      assert.is_nil(sync._workspace.documents.new.bufnr)
    end)
    bridge.request = previous_request
    assert.is_true(ok, tostring(failure))
  end)

  it('reports local save state separately from the network in ordinary file statuslines', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    local overleaf = require('overleaf')
    overleaf._state =
      { connected = false, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    edit(doc, 'LOCAL ' .. base)
    assert.is_truthy(overleaf.statusline():find('unsaved', 1, true))
    assert.is_truthy(overleaf.statusline():find('offline', 1, true))
    vim.bo[doc.bufnr].fixendofline = false
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    assert.is_truthy(overleaf.statusline():find('saved locally', 1, true))
    assert.is_falsy(overleaf.statusline():find('unsaved', 1, true))
    assert.is_truthy(overleaf.statusline():find('offline', 1, true))
  end)

  it('opens the current conflict through the public resolver without writing the source', function()
    local file = assert(io.open(options.sourceRoot .. '/main.tex', 'wb'))
    assert(file:write('independent local'))
    assert(file:close())
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    local overleaf = require('overleaf')
    overleaf._state =
      { connected = false, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    local view = overleaf.resolve()
    assert.is_truthy(view)
    assert.are.equal('independent local', text(doc.bufnr))
    assert.are.equal('independent local', read(options.sourceRoot .. '/main.tex'))
    view:close()
  end)

  it('reconnects the network without replacing the workspace or the live editor history', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'KEEP ' .. base)
    local overleaf = require('overleaf')
    overleaf._state =
      { connected = false, project_id = 'project', project_name = 'Paper', documents = sync._workspace.documents }
    local context, before = sync._workspace, vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree)
    local original, connections = bridge.request, 0
    bridge.request = function(method, params, callback)
      if method == 'connect' then
        callback(nil, { project = { rootFolder = { docs = { { _id = 'doc', name = 'main.tex' } } } } })
      elseif method == 'syncConnect' then
        connections = connections + 1
        callback(nil, { transport = { state = 'idle' } })
      else
        original(method, params, callback)
      end
    end
    local ok, failure = pcall(function()
      overleaf._reconnect_to_project('test-cookie')
      assert.is_true(vim.wait(10000, function() return connections == 1 end))
      assert.are.equal(context, sync._workspace)
      assert.is_true(overleaf._state.connected)
      assert.is_false(doc.controller.stopped or false)
      assert.are.equal('KEEP ' .. base, text(doc.bufnr))
      assert.are.same(before, vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree))
      assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    end)
    bridge.request = original
    assert.is_true(ok, tostring(failure))
  end)

  for _, mode in ipairs({ 'manual', 'unexpected' }) do
    it('keeps a late document connection reply offline after ' .. mode .. ' disconnect', function()
      local doc = open('doc', 'main.tex', { content = base, version = 1 })
      local overleaf = require('overleaf')
      overleaf._state = { connected = true, project_id = 'project', documents = sync._workspace.documents }
      sync._workspace.connected = true
      local old_request, old_reconnect = bridge.request, overleaf._attempt_reconnect
      local late, completed
      overleaf._attempt_reconnect = function() end
      bridge.request = function(method, params, callback)
        if method == 'syncConnect' then
          late = callback
        else
          old_request(method, params, callback)
        end
      end
      local ok, failure = pcall(function()
        sync.connect_documents(function() completed = true end)
        assert.is_truthy(late)
        if mode == 'manual' then
          overleaf.disconnect()
        else
          overleaf._setup_event_handlers()
          overleaf._connection_handlers.disconnect({ reason = 'network lost' })
        end
        assert.is_false(sync._workspace.connected)
        late(nil, { transport = { state = 'idle' } })
        assert.is_true(vim.wait(1000, function() return completed end))
        assert.is_false(doc.connected)
        assert.is_false(doc.connecting)
        assert.is_false(doc.controller.stopped or false)
        assert.are.equal(base, text(doc.bufnr))
      end)
      bridge.request, overleaf._attempt_reconnect = old_request, old_reconnect
      assert.is_true(ok, tostring(failure))
    end)
  end

  it('reviews retained captures after reopening and restores their text as one undoable local edit', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.api.nvim_buf_set_lines(doc.bufnr, 0, 1, false, { 'RETAINED unsaved' })
    finish(function(done) sync.close_workspace(done) end)
    vim.api.nvim_buf_delete(doc.bufnr, { force = true })
    finish(function(done) sync.open_workspace(options, done) end)
    doc = open('doc', 'main.tex', nil, { recovery = 'current' })
    local review = doc.controller:inspect()
    local capture
    for _, candidate in ipairs(review.captures) do
      if candidate.content == 'RETAINED unsaved\nseparator\nending' then capture = candidate end
    end
    assert.is_not_nil(capture)
    local before = text(doc.bufnr)
    doc.controller:restore_capture(review, capture)
    assert.are.equal(capture.content, text(doc.bufnr))
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('normal! u') end)
    assert.are.equal(before, text(doc.bufnr))
    assert.is_false(pcall(doc.controller.restore_capture, doc.controller, review, capture))
    assert.is_truthy(uv.fs_stat(capture.path .. '/snapshot.json'))
  end)

  it('retains final uncheckpointed text on Neovim exit without saving the source', function()
    local script = ([=[
      vim.opt.rtp:append(%q)
      local bridge, sync = require('overleaf.bridge'), require('overleaf.sync')
      require('overleaf.buffer').setup_native = function() end
      local function finish(start)
        local done, err, result
        start(function(failure, value) done, err, result = true, failure, value end)
        assert(vim.wait(10000, function() return done end), 'timeout')
        assert(not err, vim.inspect(err)); return result
      end
      finish(function(done) bridge.start(done) end)
      local context = finish(function(done) sync.open_workspace({ root = %q, sourceRoot = %q,
        server = 'https://example.test', projectId = 'child' }, done) end)
      local doc = finish(function(done) sync.open_document({ id = 'doc', path = 'main.tex' },
        { initial = { content = 'saved', version = 1 } }, done) end)
      assert(vim.wait(10000, function() return doc.controller:idle() end))
      vim.fn.writefile({ context.directory }, %q)
      vim.api.nvim_buf_set_lines(doc.bufnr, 0, -1, false, { 'FINAL unsaved' })
      vim.cmd('qa!')
    ]=]):format(vim.fn.getcwd(), root .. '/child-state', root .. '/child-source', root .. '/capture-location')
    local child = vim
      .system(
        { vim.v.progpath, '--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', '/dev/stdin' },
        { stdin = script, text = true }
      )
      :wait(20000)
    assert.are.equal(0, child.code, child.stderr)
    local directory = vim.fn.readfile(root .. '/capture-location')[1]
    local found = false
    for _, filename in ipairs(vim.fn.glob(directory .. '/editor-captures/*/snapshot.json', false, true)) do
      local snapshot = vim.json.decode(read(filename))
      if snapshot.content == 'FINAL unsaved' then
        found = true
        assert.are.equal('doc', snapshot.document)
        assert.are.equal(root .. '/child-source/main.tex', snapshot.source)
      end
    end
    assert.is_true(found)
    assert.are.equal('saved', read(root .. '/child-source/main.tex'))
    assert.are.equal(0, #rpc('syncInspectLocks', {
      root = root .. '/child-state',
      server = 'https://example.test',
      projectId = 'child',
    }).locks)
  end)

  it(
    'recovers a killed bridge through reviewed stale locks while retaining newer dirty text and native undo',
    function()
      local doc = open('doc', 'main.tex', { content = base, version = 1 })
      edit(doc, 'CHECKPOINTED ' .. base)
      vim.api.nvim_buf_set_lines(doc.bufnr, 0, 1, false, { 'LATEST unsaved' })
      vim.bo[doc.bufnr].undolevels = vim.bo[doc.bufnr].undolevels
      local before = vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree)
      local old_exit = bridge._on_unexpected_exit
      bridge._on_unexpected_exit = nil
      local ok, problem = pcall(function()
        assert(uv.kill(vim.fn.jobpid(bridge._job_id), 'sigkill'))
        assert.is_true(vim.wait(5000, function() return not bridge.is_running() end))
        sync.network_disconnected()
        finish(function(done) bridge.start(done) end)
        finish(function(done) sync.close_workspace(done) end)
        local review = rpc('syncInspectLocks', options)
        assert.are.equal(2, #review.locks)
        for _, lock in ipairs(review.locks) do
          assert.are.equal('stale', lock.inspection.state)
        end
        rpc('syncRecoverLocks', { review = review })
        finish(function(done) sync.open_workspace(options, done) end)
        local reopened = open('doc', 'main.tex', nil, { recovery = 'current' })
        assert.are.equal(doc.bufnr, reopened.bufnr)
        assert.are.equal('LATEST unsaved\nseparator\nending', text(reopened.bufnr))
        assert.are.same(before, vim.api.nvim_buf_call(reopened.bufnr, vim.fn.undotree))
        assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
        assert.is_true(vim.bo[reopened.bufnr].modified)
      end)
      bridge._on_unexpected_exit = old_exit
      assert.is_true(ok, tostring(problem))
    end
  )

  it('exposes current editor text to read-only features without making another authoritative mirror', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    edit(doc, 'SEARCH ' .. base)
    assert.are.equal('SEARCH ' .. base, doc.content)
    assert.are.equal(1, doc.version)
    assert.is_false(doc.joined)
    vim.api.nvim_buf_set_lines(doc.bufnr, 0, 1, false, { 'NEWER search' })
    assert.are.equal('NEWER search\nseparator\nending', doc.content)
    assert.are.equal(base, read(options.sourceRoot .. '/main.tex'))
    doc.controller:stop()
    vim.api.nvim_buf_delete(doc.bufnr, { force = true })
    finish(function(done) sync.reconcile(done) end)
    assert.are.equal(base, doc.content)
  end)

  it('attaches a known source opened with :edit before an immediate ordinary write', function()
    local doc = finish(
      function(done)
        sync.open_document({ id = 'doc', path = 'main.tex' }, {
          background = true,
          initial = { content = base, version = 1 },
        }, done)
      end
    )
    local filename = options.sourceRoot .. '/main.tex'
    vim.cmd('edit ' .. vim.fn.fnameescape(filename))
    local buf = vim.api.nvim_get_current_buf()
    buffers[#buffers + 1] = buf
    assert.are.equal(buf, doc.bufnr)
    assert.is_truthy(doc.controller)
    assert.are.same({ buf }, tool_buffers)
    vim.bo[buf].fixendofline = false
    vim.api.nvim_buf_set_lines(buf, 0, 1, false, { 'IMMEDIATE save' })
    vim.cmd('write')
    assert.are.equal('IMMEDIATE save\nseparator\nending', read(filename))
    assert.are.equal(
      'IMMEDIATE save\nseparator\nending',
      rpc('syncDocument', {
        session = sync._workspace.session,
        document = 'doc',
        action = 'state',
      }).state.saved
    )
  end)

  for _, source_path in ipairs({ 'main.tex', 'chapters/50%.tex' }) do
    it('compiles saved ' .. source_path .. ' offline without unsaved editor text', function()
      local doc = open('doc', source_path, { content = base, version = 1 })
      edit(doc, 'UNSAVED ' .. base)
      local project = require('overleaf.project')
      project._project_tree = { { id = 'doc', path = source_path, type = 'doc' } }
      rpc(
        'syncProject',
        { session = sync._workspace.session, project = { name = 'Paper', tree = project._project_tree } }
      )
      local cfg = require('overleaf.config').get()
      local previous = cfg.compile
      cfg.compile = {
        backend = 'local',
        open_pdf = false,
        local_command = {
          'node',
          '-e',
          'const fs=require("fs"); fs.copyFileSync(process.argv[1], require("path").basename(process.argv[1], ".tex") + ".pdf");',
          '{main}',
        },
      }
      local ok, failure = pcall(function()
        local result = finish(
          function(done) require('overleaf.local_compile').compile({ documents = sync._workspace.documents }, done) end
        )
        assert.are.equal(base, read(result.pdf_path))
        assert.are_not.equal(options.sourceRoot .. '/main.pdf', result.pdf_path)
        assert.is_nil(uv.fs_stat(options.sourceRoot .. '/main.pdf'))
        assert.are.equal('UNSAVED ' .. base, text(doc.bufnr))
        assert.are.equal(base, read(options.sourceRoot .. '/' .. source_path))
        assert.is_true(vim.bo[doc.bufnr].modified)
      end)
      cfg.compile = previous
      assert.is_true(ok, tostring(failure))
    end)
  end

  it('watches saved inputs sequentially and publishes a stable PDF without rebuilding unsaved edits', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    local project, compiler = require('overleaf.project'), require('overleaf.local_compile')
    project._project_tree = { { id = 'doc', path = 'main.tex', type = 'doc' } }
    rpc(
      'syncProject',
      { session = sync._workspace.session, project = { name = 'Paper', tree = project._project_tree } }
    )
    local cfg, previous = require('overleaf.config').get(), require('overleaf.config').get().compile
    cfg.compile = {
      open_pdf = false,
      local_command = {
        'node',
        '-e',
        'const fs=require("fs"); fs.copyFileSync(process.argv[1], "main.pdf");',
        '{main}',
      },
    }
    local ok, failure = pcall(function()
      compiler.start_watch({ documents = sync._workspace.documents })
      assert.is_true(compiler.is_watch_running())
      local watch = compiler._watch
      assert.is_true(vim.wait(10000, function() return watch.result ~= nil end))
      local first = watch.result
      assert.are.equal(base, read(first.pdf_path))
      edit(doc, 'UNSAVED ' .. base)
      watch.tick()
      assert.is_true(vim.wait(10000, function() return not watch.busy end))
      assert.are.equal(first, watch.result)
      assert.are.equal(base, read(first.pdf_path))
      vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
      watch.tick()
      watch.tick() -- Duplicate notifications must not launch competing builds.
      assert.is_true(vim.wait(10000, function() return watch.result ~= first end))
      assert.are.equal(first.pdf_path, watch.result.pdf_path)
      assert.are_not.equal(first.directory, watch.result.directory)
      assert.are.equal('UNSAVED ' .. base, read(watch.result.pdf_path))
      assert.are.equal(base, read(first.directory .. '/main.tex'))
      compiler.stop_watch({ silent = true })
      assert.is_false(compiler.is_watch_running())
      watch.tick()
      assert.is_nil(compiler._watch)
    end)
    compiler.stop_watch({ silent = true })
    cfg.compile = previous
    assert.is_true(ok, tostring(failure))
  end)

  it('does not start a captured compile after watch mode is stopped', function()
    open('doc', 'main.tex', { content = base, version = 1 })
    local project, compiler = require('overleaf.project'), require('overleaf.local_compile')
    project._project_tree = { { id = 'doc', path = 'main.tex', type = 'doc' } }
    rpc(
      'syncProject',
      { session = sync._workspace.session, project = { name = 'Paper', tree = project._project_tree } }
    )
    local cfg, previous = require('overleaf.config').get(), require('overleaf.config').get().compile
    cfg.compile =
      { open_pdf = false, local_command = { 'node', '-e', 'require("fs").writeFileSync("started", "yes")', '{main}' } }
    local original, late, captured = bridge.request
    bridge.request = function(method, params, callback)
      original(method, params, function(err, result)
        if method == 'syncCaptureBuild' then
          captured = result
          late = function() callback(err, result) end
        else
          callback(err, result)
        end
      end)
    end
    local ok, failure = pcall(function()
      compiler.start_watch({ documents = sync._workspace.documents })
      assert.is_true(vim.wait(10000, function() return late ~= nil end))
      compiler.stop_watch({ silent = true })
      late()
      assert.is_false(compiler.is_watch_running())
      assert.is_nil(compiler._watch_job_id)
      assert.is_nil(uv.fs_stat(captured.directory .. '/started'))
    end)
    compiler.stop_watch({ silent = true })
    bridge.request, cfg.compile = original, previous
    assert.is_true(ok, tostring(failure))
  end)

  it(
    'routes remote compilation through saved-revision confirmation and ignores results after a project switch',
    function()
      local overleaf = require('overleaf')
      overleaf._state =
        { connected = true, project_id = 'project', documents = sync._workspace.documents, csrf_token = 'fixture' }
      local cfg, previous = require('overleaf.config').get(), require('overleaf.config').get().compile
      cfg.compile = { backend = 'overleaf' }
      local old_request, old_pdf, old_log = bridge.request, overleaf._open_pdf, overleaf._parse_compile_log
      local captured, callback, shown = nil, nil, false
      overleaf._open_pdf, overleaf._parse_compile_log = function() shown = true end, function() shown = true end
      bridge.request = function(method, params, done)
        if method == 'syncCompile' then
          captured, callback = params, done
        elseif method == 'compile' then
          done({ message = 'unguarded compilation' })
        else
          old_request(method, params, done)
        end
      end
      local ok, failure = pcall(function()
        overleaf.compile()
        assert.is_true(vim.wait(10000, function() return callback ~= nil end))
        assert.are.equal(sync._workspace.session, captured.session)
        finish(function(done) sync.close_workspace(done) end)
        callback(nil, { status = 'success', outputFiles = {}, log = 'old project log' })
        vim.wait(30, function() return shown end)
        assert.is_false(shown)
      end)
      bridge.request, overleaf._open_pdf, overleaf._parse_compile_log, cfg.compile =
        old_request, old_pdf, old_log, previous
      assert.is_true(ok, tostring(failure))
    end
  )

  it('uses bounded single-component PDF names even when project titles contain path separators', function()
    local overleaf = require('overleaf')
    overleaf._state = { project_id = 'project', project_name = '../a/b\\c' .. string.rep('日', 100), documents = {} }
    local original, captured = bridge.request, nil
    bridge.request = function(method, params)
      assert.are.equal('downloadUrl', method)
      captured = params
    end
    local ok, failure = pcall(function()
      overleaf._open_pdf({ { path = 'output.pdf', url = 'https://example.test/output.pdf' } })
      assert.is_truthy(captured)
      assert.is_nil(captured.fileName:find('[/\\]'))
      assert.is_true(#captured.fileName <= 240)
      assert.is_truthy(captured.fileName:match('%.pdf$'))
    end)
    bridge.request = original
    assert.is_true(ok, tostring(failure))
  end)

  it('allows the public local compile command while the project is offline', function()
    local overleaf, compiler = require('overleaf'), require('overleaf.local_compile')
    local cfg = require('overleaf.config').get()
    local previous, old_compile = cfg.compile, compiler.compile
    local invoked = false
    cfg.compile = { backend = 'local' }
    compiler.compile = function() invoked = true end
    overleaf._state = { connected = false, documents = sync._workspace.documents }
    local ok, failure = pcall(overleaf.compile)
    cfg.compile, compiler.compile = previous, old_compile
    assert.is_true(ok, tostring(failure))
    assert.is_true(invoked)
  end)

  it('restores clean archived undo without a recovery prompt when reopening a fresh file buffer', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'SAVED ' .. base)
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    finish(function(done) sync.close_workspace(done) end)
    vim.api.nvim_buf_delete(doc.bufnr, { force = true })
    finish(function(done) sync.open_workspace(options, done) end)
    local prompts = 0
    vim.ui.select = function(_, _, callback)
      prompts = prompts + 1
      callback(nil)
    end
    local reopened = open('doc', 'main.tex')
    assert.are.equal(0, prompts)
    assert.are.equal('SAVED ' .. base, text(reopened.bufnr))
    vim.api.nvim_buf_call(reopened.bufnr, function() vim.cmd('silent undo') end)
    assert.are.equal(base, text(reopened.bufnr))
  end)

  it('keeps existing native branches when a clean archive matches the file being reopened', function()
    local doc = open('doc', 'main.tex', { content = base, version = 1 })
    vim.bo[doc.bufnr].fixendofline = false
    edit(doc, 'SAVED ' .. base)
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('write') end)
    finish(function(done) sync.close_workspace(done) end)
    vim.api.nvim_buf_set_lines(doc.bufnr, 0, 1, false, { 'ANOTHER branch' })
    vim.bo[doc.bufnr].undolevels = vim.bo[doc.bufnr].undolevels
    vim.api.nvim_buf_call(doc.bufnr, function() vim.cmd('silent undo') end)
    local before = vim.api.nvim_buf_call(doc.bufnr, vim.fn.undotree)
    finish(function(done) sync.open_workspace(options, done) end)
    local reopened = open('doc', 'main.tex')
    assert.are.same(before, vim.api.nvim_buf_call(reopened.bufnr, vim.fn.undotree))
    vim.api.nvim_buf_call(reopened.bufnr, function() vim.cmd('silent redo') end)
    assert.are.equal('ANOTHER branch\nseparator\nending', text(reopened.bufnr))
    assert.are.equal('SAVED ' .. base, read(options.sourceRoot .. '/main.tex'))
  end)
end)
