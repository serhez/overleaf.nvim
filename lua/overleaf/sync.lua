--- Ordinary source workspaces and durable synchronization coordination.
local config = require('overleaf.config')
local bridge = require('overleaf.bridge')
local M = { _sync_dir = nil }

function M.dir() return M._sync_dir end
function M.stop() M._sync_dir = nil end

--- Get the local file path for a document
---@param doc_path string Overleaf document path
---@return string|nil
function M.file_path(doc_path)
  if not M._sync_dir then return nil end
  return M._sync_dir .. '/' .. doc_path
end

--- Get the document path for a local mirror path.
---@param file_path string local file path
---@return string|nil doc_path
function M.doc_path_from_file_path(file_path)
  if not M._sync_dir or not file_path or file_path == '' then return nil end
  local root = M._sync_dir:gsub('/+$', '')
  if file_path == root then return '' end
  if file_path:sub(1, #root + 1) == root .. '/' then return file_path:sub(#root + 2) end
  return nil
end

--- Get the live buffer name for a document.
---@param doc_path string Overleaf document path
---@return string
function M.buf_name(doc_path) return 'overleaf://' .. doc_path end

--- Check if a buffer name belongs to an Overleaf buffer (either URI or sync path)
---@param bufname string
---@return string|nil doc_path the document path if it's an Overleaf buffer
function M.parse_buf_name(bufname)
  if bufname:match('^overleaf://') then return bufname:gsub('^overleaf://', '') end
  return M.doc_path_from_file_path(bufname)
end

--- Compatibility commands reconcile owned sources; cached text is never exported.
function M.sync_all(_, tree, callback)
  if M._workspace then return M.sync_tree(tree, callback) end
  local err = { code = 'NO_WORKSPACE', message = 'Open a project workspace before synchronizing' }
  if callback then
    callback(err)
  else
    config.log('warn', '%s', err.message)
  end
end

function M.import_all()
  if M._workspace then return M.reconcile() end
  config.log('warn', 'Open a project workspace before synchronizing')
end

M.export_all = M.import_all

local function document(entry)
  return setmetatable({ doc_id = entry.id, path = entry.path, engine = true }, {
    __index = function(doc, key)
      if key ~= 'content' and key ~= 'version' and key ~= 'joined' then return end
      local state = (doc.controller and not doc.controller.stopped and doc.controller.state) or doc.state
      if key == 'version' then return state and state.remoteVersion end
      if key == 'joined' then return doc.connected == true end
      if doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) and vim.api.nvim_buf_is_loaded(doc.bufnr) then
        return table.concat(vim.api.nvim_buf_get_lines(doc.bufnr, 0, -1, false), '\n')
      end
      -- Feature consumers use native LF text; the engine retains exact physical
      -- bytes independently. A closed editor's unsaved archive is not its file.
      local bytes = state and type(state.disk) == 'table' and state.disk.content or (state and state.saved)
      return type(bytes) == 'string' and bytes:gsub('^\239\187\191', ''):gsub('\r\n', '\n') or nil
    end,
  })
end

local function refresh_features(context, doc)
  if doc.feature_scheduled then return end
  doc.feature_scheduled = true
  vim.defer_fn(function()
    doc.feature_scheduled = false
    if M._workspace ~= context or context.closing or context.documents[doc.doc_id] ~= doc then return end
    local tick = doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) and vim.api.nvim_buf_get_changedtick(doc.bufnr)
    local state = doc.controller and doc.controller.state or doc.state
    local signature = { tick, state and state.remoteVersion, state and state.publication == 'local-only' }
    if vim.deep_equal(signature, doc.feature_view) then return end
    require('overleaf.comments').refresh_document(doc, function(err)
      if not err then doc.feature_view = signature end
    end)
  end, 75)
end

local workspace_jobs, workspace_busy = {}, false
local function run_workspace_job()
  if workspace_busy or #workspace_jobs == 0 then return end
  workspace_busy = true
  local job = table.remove(workspace_jobs, 1)
  local finished = false
  local function done(err, value)
    if finished then return end
    finished, workspace_busy = true, false
    local ok, callback_error = pcall(job.callback, err, value)
    run_workspace_job()
    if not ok then vim.schedule(function() error(callback_error) end) end
  end
  local ok, err = pcall(job.start, done)
  if not ok then done({ code = 'WORKSPACE_ERROR', message = tostring(err) }) end
end

local function workspace_job(start, callback)
  workspace_jobs[#workspace_jobs + 1] = {
    start = start,
    callback = callback or function(err)
      if err then config.log('error', '%s', err.message) end
    end,
  }
  run_workspace_job()
end

local function close_workspace(done)
  local context = M._workspace
  if not context then
    done()
    return
  end
  context.closing = true
  bridge.off_event('syncChanged', context.changed)
  if context.group then
    vim.api.nvim_del_augroup_by_id(context.group)
    context.group = nil
  end
  for _, pending in ipairs(vim.tbl_values(context.opening)) do
    pending.complete({ code = 'SESSION_CLOSED', message = 'Project closed while opening the document' })
  end
  for _, doc in pairs(context.documents) do
    if doc.controller then doc.controller:stop() end
  end
  bridge.request('syncClose', { session = context.session }, function(err)
    if err and err.code ~= 'STALE_SESSION' then
      done(err)
      return
    end
    if M._workspace == context then
      M._workspace, M._sync_dir = nil, nil
    end
    done()
  end)
end

--- Close project ownership without wiping buffers or saving unsaved text.
function M.close_workspace(callback) workspace_job(close_workspace, callback) end

--- Replace document transports without reopening local files or editors.
function M.network_disconnected()
  local context = M._workspace
  if not context then return end
  context.connected, context.connection_generation = false, {}
  for _, doc in pairs(context.documents) do
    doc.connected, doc.connecting, doc.connection_token = false, false, nil
  end
end

function M.connect_documents(callback)
  callback = callback or function(err)
    if err then config.log('warn', '%s', err.message) end
  end
  local context = M._workspace
  if not context or context.closing or not context.connected then
    callback({ code = 'OFFLINE', message = 'No connected project workspace' })
    return
  end
  local generation = {}
  context.connection_generation = generation
  local ids, failures, index = vim.tbl_keys(context.documents), {}, 0
  table.sort(ids)
  local function next_document()
    if M._workspace ~= context or context.closing or context.connection_generation ~= generation then
      callback({ code = 'SESSION_CLOSED', message = 'Project connection changed while reconnecting' })
      return
    end
    index = index + 1
    local id = ids[index]
    if not id then
      callback(#failures > 0 and { code = 'DOCUMENT_CONNECTIONS', message = table.concat(failures, '\n') } or nil)
      return
    end
    local doc = context.documents[id]
    local token = {}
    doc.connection_token, doc.connecting, doc.connected = token, true, false
    bridge.request('syncConnect', { session = context.session, document = id }, function(err, reply)
      if M._workspace ~= context or context.closing or context.connection_generation ~= generation then
        next_document()
        return
      end
      if doc.connection_token == token then
        doc.connecting, doc.connected, doc.transport_error =
          false, not err and not (reply and reply.transport and reply.transport.state == 'local-only'), err
        if doc.controller and not doc.controller.stopped then doc.controller:refresh() end
      end
      if err then failures[#failures + 1] = doc.path .. ': ' .. err.message end
      vim.schedule(next_document)
    end)
  end
  next_document()
end

local function scan_document(context, doc, callback)
  if doc.scanning then
    doc.scanning[#doc.scanning + 1] = callback
    return
  end
  doc.scanning = { callback }
  local function finish(err, reply)
    local callbacks = doc.scanning
    doc.scanning = nil
    if reply then doc.state = reply.state end
    doc.scan_error = err
    for _, receive in ipairs(callbacks) do
      receive(err, reply)
    end
  end
  local function request(action, fields, receive)
    bridge.request(
      'syncDocument',
      vim.tbl_extend('force', fields, {
        session = context.session,
        document = doc.doc_id,
        action = action,
      }),
      function(err, reply)
        if M._workspace ~= context or context.closing then
          finish({ code = 'SESSION_CLOSED', message = 'Project changed while reconciling' })
        elseif err then
          finish(err)
        else
          receive(reply)
        end
      end
    )
  end
  request('scan', {}, function(reply)
    local controller = doc.controller
    if controller and not controller.stopped then
      controller:refresh()
      finish(nil, reply)
      return
    end
    local update = reply.result
    if not update or update == vim.NIL or update.status ~= 'undo-required' then
      finish(nil, reply)
      return
    end
    local ok, artifact =
      pcall(require('overleaf.editor.history').rebase_saved, update.checkpoint, update.bytes, update.history)
    if not ok then
      local message = tostring(artifact)
      if message:find('HISTORY_HELD:', 1, true) or message:find('HISTORY_LIMIT:', 1, true) then
        request('holdDiskUndo', {
          revision = reply.revision,
          token = update.token,
          reason = message:find('HISTORY_LIMIT:', 1, true) and 'history-limit' or 'undo-metadata',
        }, function(held) finish(nil, held) end)
      else
        finish({ code = 'HISTORY_ERROR', message = message })
      end
      return
    end
    request(
      'writeDiskUndo',
      { revision = reply.revision, token = update.token, checkpoint = artifact.checkpoint, bytes = artifact.bytes },
      function(written) finish(nil, written) end
    )
  end)
end

--- Rescan confirmed disk revisions. Compatibility import/export calls cannot
--- promote buffer text to a save or replace a file from an obsolete Lua mirror.
function M.reconcile(callback)
  callback = callback or function(err)
    if err then config.log('error', '%s', err.message) end
  end
  local context = M._workspace
  if not context or context.closing then
    callback({ code = 'NO_WORKSPACE', message = 'No active workspace' })
    return
  end
  local documents = vim.tbl_keys(context.documents)
  table.sort(documents)
  local index = 0
  local function next_document()
    if M._workspace ~= context or context.closing then
      callback({ code = 'SESSION_CLOSED', message = 'Project changed while reconciling' })
      return
    end
    index = index + 1
    local id = documents[index]
    if not id then
      callback()
      return
    end
    scan_document(context, context.documents[id], function(err)
      if err then
        callback(err)
        return
      end
      next_document()
    end)
  end
  next_document()
end

--- Materialize known project sources through their guarded owners. Opening the
--- explorer or compiling never exports unsaved buffer text into these files.
function M.sync_tree(tree, callback)
  callback = callback or function(err)
    if err then config.log('error', '%s', err.message) end
  end
  local context = M._workspace
  if not context or context.closing then
    callback({ code = 'NO_WORKSPACE', message = 'No active workspace' })
    return
  end
  local entries, failures, index = vim.deepcopy(tree), {}, 0
  local known = {}
  for _, entry in ipairs(entries) do
    known[entry.id] = true
    entry.path = context.sources[entry.id] or context.asset_sources[entry.id] or entry.path
  end
  -- Retained identities must stay reviewable when absent from the remote tree.
  for id, relative in pairs(context.sources) do
    if not known[id] then entries[#entries + 1] = { id = id, path = relative, type = 'doc', retained = true } end
  end
  for id, relative in pairs(context.asset_sources) do
    if not known[id] then entries[#entries + 1] = { id = id, path = relative, type = 'file', retained = true } end
  end
  local function next_entry()
    if M._workspace ~= context or context.closing then
      callback({ code = 'SESSION_CLOSED', message = 'Project changed while synchronizing its tree' })
      return
    end
    index = index + 1
    local entry = entries[index]
    if not entry then
      M.reconcile(function(err)
        if err then failures[#failures + 1] = err.message end
        callback(#failures > 0 and { code = 'PROJECT_SYNC', message = table.concat(failures, '\n') } or nil)
      end)
      return
    end
    local function receive(err, reply)
      if err then
        failures[#failures + 1] = entry.path .. ': ' .. err.message
      elseif entry.type == 'file' then
        context.assets[entry.id] = reply
        context.asset_sources[entry.id] = reply.state.path
      end
      vim.schedule(next_entry)
    end
    if entry.type == 'doc' then
      M.open_document(entry, { background = true }, receive)
    elseif entry.type == 'file' then
      bridge.request(context.connected and not entry.retained and 'syncFetchAsset' or 'syncAsset', {
        session = context.session,
        document = entry.id,
        path = entry.path,
        cookie = context.connected and config.get().cookie or nil,
      }, receive)
    else
      vim.schedule(next_entry)
    end
  end
  next_entry()
end

--- Open an ordinary source workspace. Source and recovery roots are separate;
--- default source paths use the bridge's normalized server/project identity.
function M.open_workspace(options, callback)
  options = vim.deepcopy(options)
  workspace_job(function(done)
    close_workspace(function(close_error)
      if close_error then
        done(close_error)
        return
      end
      M.stop()
      local params = {
        root = vim.fn
          .fnamemodify(vim.fn.expand(options.root or (vim.fn.stdpath('state') .. '/overleaf/recovery')), ':p')
          :gsub('/$', ''),
        server = options.server or config.get().base_url,
        projectId = options.projectId,
      }
      bridge.request('syncLocate', params, function(location_error, location)
        if location_error then
          done(location_error)
          return
        end
        local source = options.sourceRoot
        if not source then
          local parent = config.get().sync_dir or (vim.fn.stdpath('data') .. '/overleaf/workspaces')
          source = parent .. '/' .. vim.fn.fnamemodify(location.directory, ':t')
        end
        params.server = location.server
        params.sourceRoot = vim.fn.fnamemodify(vim.fn.expand(source), ':p'):gsub('/$', '')
        local made, mkdir_error = pcall(vim.fn.mkdir, params.sourceRoot, 'p')
        if not made then
          done({ code = 'WORKSPACE_PATH', message = tostring(mkdir_error) })
          return
        end
        bridge.request('syncOpen', params, function(err, result)
          if err then
            M._failed_workspace = { params = params, options = options, error = err }
            done(err)
            return
          end
          local context = {
            session = result.session,
            directory = result.directory,
            root = result.sourceRoot,
            params = params,
            name = options.name,
            project = result.project ~= vim.NIL and result.project or nil,
            connected = options.connected == true,
            documents = {},
            opening = {},
            sources = {},
            by_path = {},
            assets = {},
            asset_sources = {},
            closing = false,
          }
          for _, source_binding in ipairs(result.sources) do
            if source_binding.kind == 'asset' then
              context.asset_sources[source_binding.document] = source_binding.path
            else
              context.sources[source_binding.document] = source_binding.path
              context.by_path[source_binding.path] = source_binding.document
            end
          end
          M._workspace, M._sync_dir, M._failed_workspace = context, context.root, nil
          context.changed = function(event)
            if event.session ~= context.session or context.closing then return end
            local doc = context.documents[event.document]
            if doc and (not doc.controller or doc.controller.stopped) then
              scan_document(context, doc, function() end)
            end
            if doc then refresh_features(context, doc) end
          end
          bridge.on_event('syncChanged', context.changed)
          context.group = vim.api.nvim_create_augroup('OverleafWorkspace', { clear = true })
          vim.api.nvim_create_autocmd('BufEnter', {
            group = context.group,
            callback = function(event)
              if M._workspace ~= context or context.closing then return end
              if vim.fn.win_gettype() == 'autocmd' then return end
              local relative = M.doc_path_from_file_path(vim.api.nvim_buf_get_name(event.buf))
              local id = relative and context.by_path[relative]
              if not id then return end
              local doc = context.documents[id]
              if context.opening[id] or (doc and doc.controller and not doc.controller.stopped) then return end
              -- BufEnter follows the native read and undo import. Finish local
              -- attachment before a chained :write can bypass the owner.
              local finished = false
              M.open_document({ id = id, path = relative }, { display = false }, function(attach_error)
                finished = true
                if attach_error then config.log('error', '%s', attach_error.message) end
              end)
              if not vim.wait(30000, function() return finished or context.closing end, 10) then
                config.log('error', 'Workspace attachment is still pending for %s', relative)
              end
            end,
          })
          done(nil, context)
        end)
      end)
    end)
  end, callback)
end

--- Project server positions into the current native view without changing text
--- ownership or the editor revision. Delayed results cannot target a new view.
function M.project_features(doc, fields, callback)
  local context, buf = M._workspace, doc.bufnr
  if not context or context.closing or context.documents[doc.doc_id] ~= doc then
    callback({ code = 'SESSION_CLOSED', message = 'Project changed before reading feature positions' })
    return
  end
  local loaded = buf and vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_is_loaded(buf)
  local tick = loaded and vim.api.nvim_buf_get_changedtick(buf) or nil
  local view = doc.content
  bridge.request(
    'syncDocument',
    vim.tbl_extend('force', fields, {
      session = context.session,
      document = doc.doc_id,
      action = 'features',
      view = view,
    }),
    function(err, reply)
      if M._workspace ~= context or context.closing or context.documents[doc.doc_id] ~= doc then
        callback({ code = 'SESSION_CLOSED', message = 'Project changed while reading feature positions' })
        return
      end
      if
        (
          loaded
          and (doc.bufnr ~= buf or not vim.api.nvim_buf_is_loaded(buf) or vim.api.nvim_buf_get_changedtick(buf) ~= tick)
        ) or (not loaded and doc.content ~= view)
      then
        callback({ code = 'STALE_VIEW', message = 'Buffer changed while mapping feature positions' })
        return
      end
      if err then
        callback(err)
        return
      end
      local state = doc.controller and doc.controller.state or doc.state
      if reply.result.version and state.remoteVersion and reply.result.version < state.remoteVersion then
        callback({ code = 'STALE_VIEW', message = 'Remote version changed while mapping feature positions' })
        return
      end
      callback(nil, reply.result, { content = view, tick = tick, buf = buf })
    end
  )
end

--- Accept a reviewed path change and update the coordinator's source lookup.
function M.relocate_document(doc, review, local_only)
  local context = M._workspace
  assert(context and not context.closing and context.documents[doc.doc_id] == doc, 'SESSION_CLOSED: Project changed')
  local result = doc.controller:relocate(review, local_only)
  assert(M._workspace == context and not context.closing, 'SESSION_CLOSED: Project changed')
  context.by_path[doc.path] = nil
  doc.path, doc.binding, doc.state = result.workspace.path, result, result.state
  context.sources[doc.doc_id], context.by_path[doc.path] = doc.path, doc.doc_id
  vim.b[doc.bufnr].overleaf_doc_path = doc.path
  if local_only then
    doc.connected, doc.connecting, doc.connection_token, doc.transport_error = false, false, nil, nil
  end
  return result
end

function M.keep_document_local(doc, review, uncertain)
  local context = M._workspace
  assert(context and not context.closing and context.documents[doc.doc_id] == doc, 'SESSION_CLOSED: Project changed')
  local result = doc.controller:keep_local(review, uncertain)
  assert(M._workspace == context and not context.closing, 'SESSION_CLOSED: Project changed')
  doc.binding, doc.state = result, result.state
  doc.connected, doc.connecting, doc.connection_token, doc.transport_error = false, false, nil, nil
  return result
end

--- Bind one document to its ordinary file and native-history controller. Only
--- unknown documents need a network snapshot; cached sources can reopen offline.
function M.open_document(entry, opts, callback)
  entry, opts = vim.deepcopy(entry), vim.deepcopy(opts or {})
  callback = callback or function(err)
    if err then config.log('error', '%s', err.message) end
  end
  local context = M._workspace
  if not context or context.closing then
    callback({ code = 'NO_WORKSPACE', message = 'Open the project workspace first' })
    return
  end
  local window = opts.winid or vim.api.nvim_get_current_win()
  local function current() return M._workspace == context and not context.closing end
  local existing = context.documents[entry.id]
  local waiting = context.opening[entry.id]
  local bound_path = context.sources[entry.id] or (existing and existing.path) or (waiting and waiting.path)
  if bound_path and bound_path ~= entry.path then
    callback({ code = 'PATH_BOUND', message = 'Document path changed; reconcile its rename before opening' })
    return
  end
  local user_callback = callback
  local function deliver(err, doc)
    if not err and not opts.background and not doc.bufnr then
      M.open_document(entry, opts, user_callback)
      return
    end
    if not err and not opts.background and opts.display ~= false and window and vim.api.nvim_win_is_valid(window) then
      vim.api.nvim_win_set_buf(window, doc.bufnr)
    end
    user_callback(err, doc)
  end
  if waiting then
    waiting.callbacks[#waiting.callbacks + 1] = deliver
    return
  end
  if
    existing
    and existing.bufnr
    and vim.api.nvim_buf_is_loaded(existing.bufnr)
    and existing.controller
    and not existing.controller.stopped
  then
    deliver(nil, existing)
    return
  end
  local pending = { path = entry.path, callbacks = { deliver } }
  context.opening[entry.id] = pending
  callback = function(err, doc)
    if pending.finished then return end
    pending.finished = true
    if context.opening[entry.id] == pending then context.opening[entry.id] = nil end
    for _, receive in ipairs(pending.callbacks) do
      local ok, callback_error = pcall(receive, err, doc)
      if not ok then vim.schedule(function() error(callback_error) end) end
    end
  end
  pending.complete = callback
  local function show(doc)
    if context.connected and not doc.connecting and not doc.connected and doc.state.publication ~= 'local-only' then
      local token = {}
      doc.connecting, doc.connection_token = true, token
      bridge.request('syncConnect', { session = context.session, document = entry.id }, function(err, reply)
        if not current() or doc.connection_token ~= token then return end
        doc.connecting, doc.connected, doc.transport_error =
          false, not err and not (reply and reply.transport and reply.transport.state == 'local-only'), err
        if doc.controller and not doc.controller.stopped then doc.controller:refresh() end
      end)
    end
    callback(nil, doc)
  end
  local function attach(binding)
    if not current() then
      callback({ code = 'SESSION_CLOSED', message = 'Project changed while opening the document' })
      return
    end
    local doc = existing or document(entry)
    doc.binding, doc.state = binding, binding.state
    context.documents[entry.id], context.sources[entry.id] = doc, entry.path
    context.by_path[entry.path] = entry.id
    if opts.background then
      show(doc)
      return
    end
    local filename = binding.workspace.root .. '/' .. binding.workspace.path
    local buf = vim.fn.bufadd(filename)
    local was_loaded = vim.api.nvim_buf_is_loaded(buf)
    vim.fn.bufload(buf)
    doc.bufnr, doc.binding = buf, binding
    vim.b[buf].overleaf_doc_id, vim.b[buf].overleaf_doc_path = entry.id, entry.path
    local function install(choice)
      if not current() or not vim.api.nvim_buf_is_loaded(buf) then
        callback({ code = 'SESSION_CLOSED', message = 'Project or buffer closed during recovery' })
        return
      end
      local ok, controller = pcall(function()
        local editor = require('overleaf.editor.session')
        local editor_options = {
          capture_directory = context.directory .. '/editor-captures',
          on_change = function() refresh_features(context, doc) end,
        }
        if choice == 'current' or (not binding.state.editorAttached and (was_loaded or vim.bo[buf].modified)) then
          return editor.use_current(buf, binding, editor_options)
        end
        if binding.state.editorAttached then
          assert(choice == 'restore', 'EDITOR_RECOVERY_REQUIRED: Choose an archived editor before attaching')
          return editor.restore(buf, binding, editor_options)
        end
        return editor.attach(buf, binding, editor_options)
      end)
      if not ok then
        callback({ code = 'EDITOR_RECOVERY_REQUIRED', message = vim.inspect(controller) })
        return
      end
      doc.controller = controller
      require('overleaf.buffer').setup_native(
        buf,
        function()
          return current()
            and context.documents[entry.id] == doc
            and doc.controller == controller
            and not controller.stopped
        end
      )
      context.documents[entry.id], context.sources[entry.id] = doc, entry.path
      show(doc)
    end
    if not binding.state.editorAttached or opts.recovery then
      install(opts.recovery)
      return
    end
    if
      binding.state.editorClean
      and not vim.bo[buf].modified
      and require('overleaf.editor.session').matches_read(buf, binding.state.disk.content)
    then
      local native = vim.api.nvim_buf_call(buf, vim.fn.undotree)
      -- A fresh read can regain its archived undo without displacing another
      -- native tree. Existing branches remain authoritative in the live editor.
      install(native.seq_last == 0 and 'restore' or 'current')
      return
    end
    vim.ui.select(
      { 'Restore archived text and undo', 'Keep the current file and undo', 'Cancel opening' },
      { prompt = 'Overleaf editor recovery: ' .. entry.path },
      function(choice)
        if choice == 'Restore archived text and undo' then
          install('restore')
        elseif choice == 'Keep the current file and undo' then
          install('current')
        else
          callback({ code = 'EDITOR_RECOVERY_REQUIRED', message = 'Archived editor retained; opening cancelled' })
        end
      end
    )
  end
  local function bind(initial)
    if not current() then
      callback({ code = 'SESSION_CLOSED', message = 'Project changed while reading the document' })
      return
    end
    local params = {
      session = context.session,
      document = entry.id,
      path = entry.path,
      action = existing and 'state' or 'open',
      initial = initial,
    }
    bridge.request('syncDocument', params, function(err, binding)
      if err then
        callback(err)
        return
      end
      -- Remember engine ownership even if editor attachment needs review.
      context.documents[entry.id] = context.documents[entry.id] or document(entry)
      local ok, failure = pcall(attach, binding)
      if not ok then callback({ code = 'EDITOR_RECOVERY_REQUIRED', message = tostring(failure) }) end
    end)
  end
  if existing or context.sources[entry.id] or opts.initial then
    bind(opts.initial)
    return
  end
  if not context.connected then
    callback({ code = 'OFFLINE', message = 'This source has not been downloaded; reconnect to open it' })
    return
  end
  bridge.request('joinDoc', { docId = entry.id }, function(err, result)
    if err then
      callback(err)
      return
    end
    bind({ content = table.concat(result.lines, '\n'), version = result.version })
  end)
end

return M
