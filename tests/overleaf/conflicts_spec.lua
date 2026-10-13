local conflicts = require('overleaf.conflicts')

local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end

describe('recovery review', function()
  local source, views
  before_each(function()
    views = {}
    source = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_set_current_buf(source)
    vim.api.nvim_buf_set_lines(source, 0, -1, false, { 'live unsaved edit' })
    vim.bo[source].undolevels = vim.bo[source].undolevels
  end)
  after_each(function()
    for _, view in ipairs(views) do
      view:close()
    end
    if vim.api.nvim_buf_is_valid(source) then vim.api.nvim_buf_delete(source, { force = true }) end
  end)
  local function fixture()
    local review = {
      revision = 8,
      state = {
        saved = 'saved branch',
        remote = { content = 'remote branch' },
        disk = { pending = { content = 'candidate' } },
      },
      disk = {
        observed = { exists = true, bytes = vim.base64.encode('actual disk\n') },
        record = {
          state = { observed = { bytes = vim.base64.encode('original disk') }, pending = { sourceInstalled = true } },
        },
        artifacts = {
          { path = '/private/undo', kind = 'undo', error = { code = 'UNSAFE_UNDO', message = 'linked artifact' } },
        },
      },
      captures = { { path = '/private/capture', content = 'captured unsaved edit' } },
    }
    local session = { buf = source, inspect = function() return review end, accepted = 0 }
    function session:recover_disk(value)
      assert.are.equal(review, value)
      self.accepted = self.accepted + 1
    end
    return session, review
  end
  it('inspects project locks without changing sources and releases them only on explicit acceptance', function()
    local calls, resumed = {}, 0
    local review = {
      directory = '/private/project',
      locks = {
        {
          label = 'project',
          inspection = { directory = '/private/project', state = 'stale', owner = { pid = 123, host = 'my-host' } },
        },
        {
          label = 'workspace',
          inspection = {
            directory = '/private/project/workspace',
            state = 'stale',
            owner = { pid = 123, host = 'my-host' },
          },
        },
      },
    }
    local view = conflicts.locks({ projectId = 'project' }, {
      request = function(method, params, callback)
        calls[#calls + 1] = { method, params }
        if method == 'syncInspectLocks' then
          callback(nil, review)
        else
          callback(nil, { retained = { '/private/project/.recovered-token' } })
        end
      end,
      on_recovered = function() resumed = resumed + 1 end,
    })
    views[#views + 1] = view
    assert.are.equal(1, #calls)
    assert.are.equal('syncInspectLocks', calls[1][1])
    assert.is_truthy(text(view.summary):find('my-host', 1, true))
    assert.is_truthy(text(view.summary):find('stale', 1, true))
    assert.is_false(vim.bo[view.summary].modifiable)
    assert.are.equal(0, resumed)
    view:accept()
    assert.are.equal('syncRecoverLocks', calls[2][1])
    assert.are.same(review, calls[2][2].review)
    assert.are.equal(1, resumed)
    assert.are.equal('live unsaved edit', text(source))
    assert.is_truthy(text(view.summary):find('/private/project/.recovered-token', 1, true))
    assert.is_false(pcall(view.accept, view))
  end)

  it('a failed lock recovery keeps the review and never resumes the project', function()
    local resumed = false
    local view = conflicts.locks({}, {
      request = function(method, _, callback)
        if method == 'syncInspectLocks' then
          callback(nil, { directory = '/private/project', locks = {} })
        else
          callback({ code = 'LOCK_CHANGED', message = 'writer changed' })
        end
      end,
      on_recovered = function() resumed = true end,
    })
    views[#views + 1] = view
    local ok = pcall(view.accept, view)
    assert.is_false(ok)
    assert.is_false(resumed)
    assert.is_false(view.accepted or false)
    assert.is_true(vim.api.nvim_buf_is_valid(view.summary))
  end)

  it('reviews binary branches without writes and accepts only an explicit reviewed choice', function()
    local calls = {}
    local review = {
      session = 'session',
      document = 'image',
      revision = 4,
      state = {
        path = 'plot.png',
        status = 'conflict',
        remote = vim.base64.encode('\255remote'),
        conflict = { base = vim.base64.encode('base') },
      },
      observation = { observed = { exists = true, bytes = vim.base64.encode('\0local') } },
    }
    local view = conflicts.asset(review, {
      request = function(method, params, callback)
        calls[#calls + 1] = { method, params }
        callback(nil, { state = { status = 'local-changes' } })
      end,
    })
    views[#views + 1] = view
    assert.are.equal(0, #calls)
    assert.is_truthy(text(view.summary):find('plot.png', 1, true))
    assert.is_truthy(text(view.buffers.local_bytes):find('00 6c 6f 63 61 6c', 1, true))
    view:accept('local')
    assert.are.equal('syncAsset', calls[1][1])
    assert.are.equal('local', calls[1][2].choice)
    assert.are.equal(4, calls[1][2].revision)
    assert.are.same(review.observation, calls[1][2].observation)
    assert.are.equal('live unsaved edit', text(source))
    assert.is_false(pcall(view.accept, view, 'remote'))
  end)

  it('keeps text local when an archive destination cannot be reviewed', function()
    local review = {
      lifecycle = { path = 'main.tex', reason = 'remote-deleted' },
      workspace = vim.NIL,
      workspaceError = { message = 'Destination belongs to another source' },
    }
    local kept = 0
    local view = conflicts.lifecycle({
      review_lifecycle = function() return review end,
      keep_local = function(_, value)
        assert.are.same(review, value)
        kept = kept + 1
      end,
    })
    views[#views + 1] = view
    assert.is_truthy(text(view.summary):find(review.workspaceError.message, 1, true))
    assert.is_false(pcall(view.archive, view))
    assert.are.equal(0, kept)
    view:accept()
    assert.are.equal(1, kept)
    assert.are.equal('live unsaved edit', text(source))
  end)

  it('offers local retention when a remote text rename destination is unavailable', function()
    local kept = false
    local view = conflicts.relocation({
      review_relocation = function()
        return { workspace = vim.NIL, workspaceError = { message = 'Rename target belongs to another source' } }
      end,
      review_lifecycle = function()
        return { lifecycle = { path = 'main.tex', reason = 'remote-renamed' }, workspace = { to = 'main.local.tex' } }
      end,
    }, { local_choices = { accept = function() kept = true end } })
    views[#views + 1] = view
    assert.is_truthy(text(view.summary):find('Rename target belongs to another source', 1, true))
    view:accept()
    assert.is_true(kept)
  end)

  it('keeps a binary file local when both relocation destinations are unavailable', function()
    local calls = {}
    local review = {
      lifecycle = { path = 'plot.png', reason = 'remote-renamed' },
      relocation = vim.NIL,
      archive = vim.NIL,
      relocationError = { message = 'Rename target is bound' },
      archiveError = { message = 'Archive target is linked' },
    }
    local view = conflicts.asset_lifecycle({ session = 'session', document = 'image' }, {
      request = function(_, params, callback)
        calls[#calls + 1] = params.action
        callback(nil, params.action == 'review' and review or { state = { path = 'plot.png', status = 'local-only' } })
      end,
    })
    views[#views + 1] = view
    assert.is_truthy(text(view.summary):find(review.relocationError.message, 1, true))
    assert.is_truthy(text(view.summary):find(review.archiveError.message, 1, true))
    assert.is_false(pcall(view.accept, view, 'archive'))
    assert.is_false(pcall(view.accept, view, 'rename'))
    assert.are.same({ 'review' }, calls)
    view:accept('local')
    assert.are.same({ 'review', 'local' }, calls)
  end)

  it('keeps a stale binary review open without marking the choice accepted', function()
    local view = conflicts.asset({
      session = 'session',
      document = 'image',
      revision = 1,
      state = { path = 'plot.png', status = 'conflict', remote = '' },
      observation = { observed = { exists = true, bytes = '' } },
    }, { request = function(_, _, callback) callback({ code = 'STALE_FILE', message = 'changed' }) end })
    views[#views + 1] = view
    assert.is_false(pcall(view.accept, view, 'remote'))
    assert.is_false(view.accepted or false)
    assert.is_true(vim.api.nvim_buf_is_valid(view.summary))
  end)
  it('opens read-only recovery evidence without changing source text or performing recovery', function()
    local session = fixture()
    local before, tick = vim.fn.undotree(), vim.api.nvim_buf_get_changedtick(source)
    local view = conflicts.recovery(session)
    views[#views + 1] = view
    assert.are.equal(0, session.accepted)
    assert.are.equal('live unsaved edit', text(source))
    assert.are.equal(tick, vim.api.nvim_buf_get_changedtick(source))
    assert.are.same(before, vim.api.nvim_buf_call(source, vim.fn.undotree))
    local summary = text(view.summary)
    assert.is_truthy(summary:find('Source installation confirmed', 1, true))
    assert.is_truthy(summary:find('/private/capture', 1, true))
    assert.is_truthy(summary:find('UNSAFE_UNDO', 1, true))
    assert.are.equal('actual disk\n', text(view.buffers.disk))
    assert.are.equal('candidate', text(view.buffers.candidate))
    assert.are.equal('captured unsaved edit', text(view.buffers.capture1))
    for _, buf in pairs(view.buffers) do
      assert.is_false(vim.bo[buf].modifiable)
      assert.is_false(vim.bo[buf].swapfile)
      assert.are.equal('nofile', vim.bo[buf].buftype)
    end
  end)
  it('restores only a selected retained capture through the guarded editor action', function()
    local session, review = fixture()
    local restored
    session.restore_capture = function(_, value, selected)
      assert.are.equal(review, value)
      restored = selected
    end
    local view = conflicts.recovery(session)
    views[#views + 1] = view
    assert.is_false(pcall(view.restore_selected, view))
    assert.is_nil(restored)
    view:show('capture1')
    view:restore_selected()
    assert.are.equal(review.captures[1], restored)
    assert.are.equal('live unsaved edit', text(source))
    assert.is_truthy(text(view.summary):find('Capture restored as unsaved text', 1, true))
  end)

  it('exports the selected recovery bytes to a new file without accepting or replacing anything', function()
    local session, review = fixture()
    review.buffer = 'newer unsaved text'
    review.held = { message = 'HISTORY_LIMIT: retained raw capture' }
    local view = conflicts.recovery(session)
    views[#views + 1] = view
    assert.are.equal('newer unsaved text', text(view.buffers.buffer))
    assert.is_truthy(text(view.summary):find('HISTORY_LIMIT', 1, true))
    local destination = vim.fn.tempname()
    view:show('disk')
    view:export_selected(destination)
    local file = assert(io.open(destination, 'rb'))
    assert.are.equal('actual disk\n', file:read('*a'))
    file:close()
    view:show('saved')
    assert.is_false(pcall(view.export_selected, view, destination))
    file = assert(io.open(destination, 'rb'))
    assert.are.equal('actual disk\n', file:read('*a'))
    file:close()
    assert.are.equal(0, session.accepted)
    assert.are.equal('live unsaved edit', text(source))
    vim.fn.delete(destination)
  end)

  it('recovers only on explicit acceptance and keeps the live buffer and review evidence', function()
    local session = fixture()
    local view = conflicts.recovery(session)
    views[#views + 1] = view
    view:accept()
    assert.are.equal(1, session.accepted)
    assert.are.equal('live unsaved edit', text(source))
    assert.is_true(vim.api.nvim_buf_is_valid(view.summary))
    assert.is_truthy(text(view.summary):find('Save the source buffer to continue', 1, true))
    local ok = pcall(view.accept, view)
    assert.is_false(ok)
    assert.are.equal(1, session.accepted)
  end)
  it('keeps a stale or failed review open and performs no implicit retry', function()
    local session = fixture()
    function session.recover_disk(_) error('STALE_FILE: disk changed') end
    local view = conflicts.recovery(session)
    views[#views + 1] = view
    local ok, err = pcall(view.accept, view)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('STALE_FILE', 1, true))
    assert.is_true(vim.api.nvim_buf_is_valid(view.summary))
    assert.are.equal('actual disk\n', text(view.buffers.disk))
    assert.are.equal('live unsaved edit', text(source))
    assert.is_false(view.accepted or false)
  end)
  it('closing the review never closes or deletes the source buffer', function()
    local session = fixture()
    local view = conflicts.recovery(session)
    views[#views + 1] = view
    view:close()
    assert.is_true(vim.api.nvim_buf_is_loaded(source))
    assert.are.equal('live unsaved edit', text(source))
    assert.are.equal(0, session.accepted)
  end)
  it('keeps uncertain upload evidence read-only until an explicit drained-queue decision', function()
    local calls = {}
    local review = {
      canRetire = true,
      saved = 'saved target',
      buffer = 'unsaved target',
      remote = { content = 'server head', version = 9 },
      pending = { base = 'old base', content = 'old submission', operation = {} },
    }
    local session = { session = 'session', document = 'doc', refresh = function() end }
    session.request = function(method, params, callback)
      assert.are.equal('syncUploadReview', method)
      calls[#calls + 1] = params
      callback(nil, params.accept and { status = 'review-required' } or review)
    end
    local view = conflicts.upload(session)
    views[#views + 1] = view
    assert.are.equal(1, #calls)
    assert.are.equal('old submission', text(view.buffers.submitted))
    assert.are.equal('unsaved target', text(view.buffers.buffer))
    assert.is_false(vim.bo[view.buffers.submitted].modifiable)
    view:accept()
    assert.are.equal(2, #calls)
    assert.is_true(calls[2].accept)
    assert.are.equal(review, calls[2].review)
    assert.are.equal('live unsaved edit', text(source))
    assert.is_false(pcall(view.accept, view))
  end)

  it('can keep an unprovable upload local without accepting a remote outcome', function()
    local review = {
      canRetire = false,
      saved = 'saved',
      buffer = 'unsaved',
      remote = { content = 'remote' },
      pending = { base = 'base', content = 'submitted', operation = {} },
    }
    local requests, detached = 0, 0
    local session = { session = 'session', document = 'doc' }
    session.request = function(_, params, callback)
      requests = requests + 1
      assert.is_nil(params.accept)
      callback(nil, review)
    end
    local view = conflicts.upload(session, {
      detach = function(actual)
        assert.are.equal(review, actual)
        detached = detached + 1
      end,
    })
    views[#views + 1] = view
    assert.is_false(pcall(view.accept, view))
    assert.are.equal(0, detached)
    view:detach()
    assert.are.equal(1, detached)
    assert.are.equal(1, requests)
    assert.are.equal('live unsaved edit', text(source))
    assert.is_false(pcall(view.detach, view))
  end)

  it('imports a saved CodeDiff draft without accepting it and refuses to replace a newer native draft', function()
    local root = vim.fn.tempname()
    vim.fn.mkdir(root, 'p')
    local review = { revision = 1, resolutions = {} }
    local calls = 0
    local session = {
      session = 'session',
      buf = source,
      review_history = function() return review end,
      close_history = function() end,
    }
    session.resolve_history = function(_, _, choices)
      calls = calls + 1
      if choices['0'] then return { status = 'accepted' } end
      return {
        status = 'conflict',
        seq = 0,
        inputs = { base = 'base', ['local'] = 'local', remote = 'remote' },
        candidate = 'candidate',
      }
    end
    session.request = function(method, params, callback)
      assert.are.equal('syncMergeView', method)
      assert.are.same({ base = 'base', ['local'] = 'local', remote = 'remote' }, params.inputs)
      vim.fn.writefile({ params.candidate }, root .. '/result', 'b')
      callback(nil, { directory = root, path = root .. '/result', candidate = root .. '/original' })
    end
    vim.api.nvim_create_user_command('CodeDiff', function(opts)
      assert.are.equal('merge', opts.fargs[1])
      vim.cmd('tabedit ' .. vim.fn.fnameescape(opts.fargs[2]))
    end, { nargs = '+' })
    local adapter
    local old_index = vim.env.GIT_INDEX_FILE
    local ok, failure = pcall(function()
      local view = conflicts.history(session)
      views[#views + 1] = view
      vim.env.GIT_INDEX_FILE = '/unrelated/index'
      assert.is_nil(view:open_codediff())
      vim.env.GIT_INDEX_FILE = old_index
      adapter = view:open_codediff()
      assert.are.equal(1, calls)
      vim.api.nvim_buf_set_lines(adapter.buf, 0, -1, false, { 'resolved' })
      vim.bo[adapter.buf].fixendofline = false
      vim.api.nvim_buf_call(adapter.buf, function() vim.cmd('write') end)
      assert.are.equal('resolved', text(view.buffers.result))
      assert.is_true(vim.bo[view.buffers.result].modified)
      assert.are.equal(1, calls)
      vim.api.nvim_buf_set_lines(view.buffers.result, 0, -1, false, { 'newer native draft' })
      vim.api.nvim_buf_set_lines(adapter.buf, 0, -1, false, { 'older external draft' })
      vim.api.nvim_buf_call(adapter.buf, function() vim.cmd('write') end)
      assert.are.equal('newer native draft', text(view.buffers.result))
      assert.are.equal(1, calls)
      view:accept()
      assert.are.equal(2, calls)
    end)
    vim.env.GIT_INDEX_FILE = old_index
    vim.api.nvim_del_user_command('CodeDiff')
    if adapter and vim.api.nvim_buf_is_valid(adapter.buf) then
      vim.api.nvim_buf_delete(adapter.buf, { force = true })
    end
    vim.fn.delete(root, 'rf')
    assert.is_true(ok, tostring(failure))
  end)

  it('history diffs require explicit acceptance and retain each partial choice before moving on', function()
    local review = { revision = 1, resolutions = {} }
    local calls = {}
    local session = { review_history = function() return review end, close_history = function() end }
    function session.resolve_history(_, actual, choices)
      assert.are.equal(review, actual)
      calls[#calls + 1] = vim.deepcopy(choices)
      if choices['2'] then return { status = 'accepted' } end
      return {
        status = 'conflict',
        seq = choices['0'] and 2 or 0,
        inputs = { base = 'ancestor', ['local'] = 'local state', remote = 'peer state' },
        candidate = '<<<<<<< LOCAL\nlocal state\n=======\npeer state\n>>>>>>> OVERLEAF',
      }
    end
    local view = conflicts.history(session)
    views[#views + 1] = view
    assert.are.equal('ancestor', text(view.buffers.base))
    assert.is_false(vim.bo[view.buffers.base].modifiable)
    assert.is_true(vim.bo[view.buffers.result].modifiable)
    assert.are.equal('acwrite', vim.bo[view.buffers.result].buftype)
    assert.are.equal(1, #calls)
    vim.api.nvim_buf_set_lines(view.buffers.result, 0, -1, false, { 'root with peer' })
    view:accept()
    assert.are.equal('root with peer', calls[2]['0'])
    assert.are.equal(2, view.conflict.seq)
    assert.is_false(view.accepted or false)
    vim.api.nvim_buf_set_lines(view.buffers.result, 0, -1, false, { 'alternate with peer' })
    view:accept()
    assert.are.same({ ['0'] = 'root with peer', ['2'] = 'alternate with peer' }, calls[3])
    assert.is_true(view.accepted)
    assert.are.equal('live unsaved edit', text(source))
  end)

  it('closing a history diff refuses to discard an edited resolution draft', function()
    local session = { review_history = function() return { resolutions = {} } end, close_history = function() end }
    function session.resolve_history(_)
      return {
        status = 'conflict',
        seq = 0,
        inputs = { base = 'base', ['local'] = 'old', remote = 'new' },
        candidate = 'candidate',
      }
    end
    local view = conflicts.history(session)
    views[#views + 1] = view
    vim.api.nvim_buf_set_lines(view.buffers.result, 0, -1, false, { 'my unsaved resolution' })
    local ok, err = pcall(view.close, view)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find('UNSAVED_RESOLUTION', 1, true))
    assert.are.equal('my unsaved resolution', text(view.buffers.result))
    vim.bo[view.buffers.result].modified = false -- Fixture cleanup explicitly discards its draft.
  end)

  it('opening a complete retained history draft previews it without accepting the live import', function()
    local accepted = 0
    local review = {
      resolutions = { ['0'] = 'reviewed choice' },
      conflict = { seq = 0, inputs = { base = 'base', ['local'] = 'old', remote = 'new' } },
    }
    local session = { review_history = function() return review end, close_history = function() end }
    function session.resolve_history(_, _, _, preview)
      if preview then return { status = 'ready' } end
      accepted = accepted + 1
      return { status = 'accepted' }
    end
    local view = conflicts.history(session)
    views[#views + 1] = view
    assert.are.equal(0, accepted)
    assert.are.equal('reviewed choice', text(view.buffers.result))
    view:accept()
    assert.are.equal(1, accepted)
  end)
  it('document diffs show current disk and server evidence and keep saved and buffer choices separate', function()
    local review = { resolutions = {} }
    local calls = {}
    local session = { review_conflict = function() return review end, close_history = function() end }
    function session.resolve_conflict(_, _, choices)
      calls[#calls + 1] = vim.deepcopy(choices)
      if choices.buffer then return { status = 'accepted' } end
      return {
        status = 'conflict',
        stage = choices.saved and 'buffer' or 'saved',
        inputs = { base = 'base', ['local'] = 'local', remote = 'remote' },
        candidate = 'candidate',
        disk = 'actual disk',
        server = 'latest server',
        original = { base = 'original', ['local'] = 'before local', remote = 'before remote' },
      }
    end
    local view = conflicts.resolve(session)
    views[#views + 1] = view
    assert.are.equal('actual disk', text(view.buffers.disk))
    assert.are.equal('latest server', text(view.buffers.server))
    vim.api.nvim_buf_set_lines(view.buffers.result, 0, -1, false, { 'resolved saved' })
    view:accept()
    assert.are.equal('resolved saved', calls[2].saved)
    assert.are.equal('buffer', view.conflict.stage)
    vim.api.nvim_buf_set_lines(view.buffers.result, 0, -1, false, { 'resolved unsaved buffer' })
    view:accept()
    assert.are.same({ saved = 'resolved saved', buffer = 'resolved unsaved buffer' }, calls[3])
    assert.is_true(view.accepted)
  end)
end)
