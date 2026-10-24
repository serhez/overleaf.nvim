local config = require('overleaf.config')
local bridge = require('overleaf.bridge')
local project = require('overleaf.project')
local sync = require('overleaf.sync')

local M = {}

local function resolve_url(base_url, url)
  if url:match('^https?://') then return url end

  if url:match('^//') then
    local scheme = base_url:match('^(https?:)') or 'https:'
    return scheme .. url
  end

  return base_url:gsub('/+$', '') .. '/' .. url:gsub('^/+', '')
end

--- Open a file with the configured viewer or platform default
---@param file_path string
local function open_file(file_path)
  local size = vim.fn.getfsize(file_path)
  if size <= 0 then
    config.log('warn', 'Not opening empty or missing file: %s', file_path)
    return
  end

  local viewer = config.get().pdf_viewer
  if viewer then
    -- User-configured viewer: run as background job to avoid disrupting cursor/window layout
    vim.fn.jobstart({ viewer, file_path }, { detach = true })
  else
    -- Auto-detect platform launcher (runs in background)
    local cmd
    if vim.fn.has('mac') == 1 then
      cmd = { 'open', file_path }
    elseif vim.fn.has('wsl') == 1 then
      cmd = { 'wslview', file_path }
    else
      cmd = { 'xdg-open', file_path }
    end
    vim.fn.system(cmd)
  end
end

local function current_document()
  local bufnr = vim.api.nvim_get_current_buf()
  for doc_id, doc in pairs(M._state.documents) do
    if doc.bufnr == bufnr then return bufnr, doc_id, doc end
  end
  return bufnr, nil, nil
end

local function clamp_col(line, col) return math.max(0, math.min(tonumber(col) or 0, #(line or ''))) end

local function next_utf8_col(line, col)
  line = line or ''
  col = clamp_col(line, col)
  if col >= #line then return #line end

  local byte = line:byte(col + 1)
  if not byte then return #line end

  local len = 1
  if byte >= 0xF0 then
    len = 4
  elseif byte >= 0xE0 then
    len = 3
  elseif byte >= 0xC0 then
    len = 2
  end

  return math.min(col + len, #line)
end

local function selected_text_range(bufnr)
  local start_pos = vim.fn.getpos("'<")
  local end_pos = vim.fn.getpos("'>")
  if not start_pos or not end_pos or start_pos[2] == 0 or end_pos[2] == 0 then
    return nil, 'Select text visually first'
  end
  if start_pos[1] ~= 0 and start_pos[1] ~= bufnr then return nil, 'Visual selection is not in this buffer' end
  if end_pos[1] ~= 0 and end_pos[1] ~= bufnr then return nil, 'Visual selection is not in this buffer' end

  local start_row = start_pos[2] - 1
  local end_row = end_pos[2] - 1
  local start_col = start_pos[3] - 1
  local end_col = end_pos[3] - 1

  if start_row > end_row or (start_row == end_row and start_col > end_col) then
    start_row, end_row = end_row, start_row
    start_col, end_col = end_col, start_col
  end

  local line_count = vim.api.nvim_buf_line_count(bufnr)
  if start_row < 0 or end_row < 0 or start_row >= line_count or end_row >= line_count then
    return nil, 'Visual selection is outside the current buffer'
  end

  local mode = vim.fn.visualmode()
  if mode == '\22' then return nil, 'Blockwise visual comments are not supported yet' end

  local start_line = vim.api.nvim_buf_get_lines(bufnr, start_row, start_row + 1, false)[1] or ''
  local end_line = vim.api.nvim_buf_get_lines(bufnr, end_row, end_row + 1, false)[1] or ''

  if mode == 'V' then
    start_col = 0
    end_col = #end_line
  else
    start_col = clamp_col(start_line, start_col)
    end_col = next_utf8_col(end_line, end_col)
  end

  local lines = vim.api.nvim_buf_get_text(bufnr, start_row, start_col, end_row, end_col, {})
  local text = table.concat(lines, '\n')
  if text == '' then return nil, 'Visual selection is empty' end

  return {
    text = text,
    start = { row = start_row, col = start_col },
    finish = { row = end_row, col = end_col },
  }
end

local function generate_comment_thread_id()
  local uv = vim.uv or vim.loop
  local seed = table.concat({
    tostring(os.time()),
    tostring(uv and uv.hrtime and uv.hrtime() or ''),
    tostring(math.random()),
  }, ':')
  local hash = vim.fn.sha256(seed)
  return string.format('%08x', os.time()) .. hash:sub(1, 10) .. '000001'
end

local function normalize_path(path)
  if not path or path == '' then return nil end
  return vim.fn.fnamemodify(vim.fn.expand(path), ':p'):gsub('/$', '')
end

local function is_inside(path, root)
  path = normalize_path(path)
  root = normalize_path(root)
  if not path or not root then return false end
  return path == root or vim.startswith(path, root .. '/')
end

local function canola_url_path(url)
  if not url or not vim.startswith(url, 'canola://') then return nil end
  return url:gsub('^canola://', '')
end

M._state = {
  connected = false,
  project_name = nil,
  project_id = nil,
  project_data = nil,
  csrf_token = nil,
  user_id = nil,
  user_email = nil,
  documents = {}, -- doc_id -> owned workspace document
}

function M.is_overleaf_context(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(bufnr) then return false end

  local bufname = vim.api.nvim_buf_get_name(bufnr)
  if bufname:match('^overleaf://') or bufname:match('^overleaf%-qf://') or bufname:match('^canola%-overleaf://') then
    return true
  end

  local active_sync_dir = sync.dir()
  if active_sync_dir and is_inside(bufname, active_sync_dir) then return true end

  local configured_sync_dir = config.get().sync_dir
  if configured_sync_dir and is_inside(bufname, configured_sync_dir) then return true end

  if vim.bo[bufnr].filetype == 'canola' then
    local ok, canola = pcall(require, 'canola')
    local url = ok and canola.get_current_url and canola.get_current_url(bufnr) or nil
    if url and vim.startswith(url, 'canola-overleaf://') then return true end
    if configured_sync_dir and is_inside(canola_url_path(url), configured_sync_dir) then return true end
    if active_sync_dir and is_inside(canola_url_path(url), active_sync_dir) then return true end
  end

  return false
end

function M.cleanup_buffers()
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) and not vim.bo[bufnr].modified then
      local name = vim.api.nvim_buf_get_name(bufnr)
      if name:match('^overleaf%-qf://') or name:match('^canola%-overleaf://') then
        pcall(vim.api.nvim_buf_delete, bufnr, { force = false })
      end
    end
  end
end

function M._reset_project_session()
  if M._reconnect then
    M._reconnect.attempt = 0
    M._reconnect.in_progress = false
    if M._reconnect.timer then
      vim.fn.timer_stop(M._reconnect.timer)
      M._reconnect.timer = nil
    end
  end

  pcall(function() require('overleaf.local_compile').stop_watch({ silent = true }) end)
  sync.stop()
  pcall(function() require('overleaf.cursors').clear_all() end)
  pcall(function() require('overleaf.comments').clear_all() end)

  M.cleanup_buffers()
  M._state.connected = false
  M._state.project_name = nil
  M._state.project_id = nil
  M._state.project_data = nil
  M._state.documents = {}
  project.parse_project_tree(nil)
end

local function setup_autocmds()
  local group = vim.api.nvim_create_augroup('OverleafNvim', { clear = false })
  vim.api.nvim_clear_autocmds({ group = group, event = { 'ExitPre', 'VimLeavePre', 'FocusGained', 'VimResume' } })
  vim.api.nvim_create_autocmd({ 'ExitPre', 'VimLeavePre' }, {
    group = group,
    desc = 'Wipe Overleaf virtual buffers before sessions are saved',
    callback = function()
      if config.get().cleanup_buffers_on_exit ~= false then M.cleanup_buffers() end
    end,
  })
  vim.api.nvim_create_autocmd({ 'FocusGained', 'VimResume' }, {
    group = group,
    desc = 'Retry an offline project when returning to the editor',
    callback = function()
      if not bridge._exiting and sync._workspace and not sync._workspace.closing then M._attempt_reconnect() end
    end,
  })
end

function M.setup(opts)
  config.setup(opts)
  setup_autocmds()
end

function M.connect()
  config.log('info', 'Starting bridge...')

  -- Step 1: Start bridge process
  bridge.start(function(err)
    if err then
      config.log('error', 'Failed to start bridge: %s', err.message)
      return
    end

    -- Step 2: Get cookie (from config, .env, or Chrome)
    M._get_cookie(function(cookie)
      if not cookie then return end

      config.log('info', 'Authenticating...')

      -- Step 3: Authenticate and get project list
      bridge.request('auth', { cookie = cookie }, function(auth_err, result)
        if auth_err then
          config.log('error', 'Authentication failed: %s', auth_err.message)
          return
        end

        config.log('info', 'Authenticated as %s (%d projects)', result.userEmail or result.userId, #result.projects)
        M._state.csrf_token = result.csrfToken
        M._state.user_id = result.userId
        M._state.user_email = result.userEmail
        project.set_projects(result.projects)

        -- Step 4: Select project
        project.select_project(
          function(project_id, project_name) M._connect_project(cookie, project_id, project_name) end
        )
      end)
    end)
  end)
end

function M._get_cookie(callback)
  -- Browser (Chrome/Arc/...) first, then config/env as fallback
  config.log('info', 'Checking browser profiles...')
  bridge.request('listBrowserProfiles', {}, function(err, result)
    if err or not result or not result.profiles or #result.profiles == 0 then
      config.log('debug', 'Browser profiles not available: %s', err and err.message or 'none found')
      M._get_cookie_fallback(callback)
      return
    end

    local profiles = result.profiles

    local function extract_from_profile(profile)
      config.log('info', 'Extracting cookie from %s (%s)...', profile.browserName, profile.dir)
      bridge.request(
        'getCookie',
        { browser = profile.browser, profile = profile.dir },
        function(cookie_err, cookie_result)
          if not cookie_err and cookie_result and cookie_result.cookie then
            config.log('info', 'Cookie extracted from %s', profile.browserName)
            config.get().cookie = cookie_result.cookie
            callback(cookie_result.cookie)
            return
          end
          config.log(
            'debug',
            '%s extraction failed: %s',
            profile.browserName,
            cookie_err and cookie_err.message or 'unknown'
          )
          M._get_cookie_fallback(callback)
        end
      )
    end

    if #profiles == 1 then
      extract_from_profile(profiles[1])
    else
      vim.schedule(function()
        vim.ui.select(profiles, {
          prompt = 'Select browser profile:',
          format_item = function(item) return item.browserName .. ' — ' .. item.name .. ' (' .. item.dir .. ')' end,
        }, function(choice)
          if choice then
            extract_from_profile(choice)
          else
            M._get_cookie_fallback(callback)
          end
        end)
      end)
    end
  end)
end

function M._get_cookie_fallback(callback)
  local cookie = config.load_cookie()
  if cookie then
    callback(cookie)
    return
  end
  config.log('error', 'No cookie found. Log in to overleaf.com in Chrome or Arc, or set OVERLEAF_COOKIE in .env')
  callback(nil)
end

function M._save_project_tree(callback)
  callback = callback or function(err)
    if err then config.log('error', '%s', err.message) end
  end
  local context = sync._workspace
  if not context then return callback({ code = 'NO_WORKSPACE', message = 'No active workspace' }) end
  local metadata = {
    name = M._state.project_name or context.name or '',
    tree = vim.deepcopy(project._project_tree),
    data = M._state.project_data,
  }
  bridge.request('syncProject', { session = context.session, project = metadata }, function(err, reply)
    if sync._workspace ~= context then return end
    if not err then context.project = reply.project end
    callback(err)
  end)
end

function M._connect_project(cookie, project_id, project_name, options)
  options = vim.tbl_extend('force', options or {}, { projectId = project_id, name = project_name })
  config.get().cookie = cookie
  M._connection_generation = (M._connection_generation or 0) + 1
  local generation = M._connection_generation
  local function current() return M._connection_generation == generation end
  M._state.manual_disconnect, M._state.connected = true, false
  if M._reconnect.timer then vim.fn.timer_stop(M._reconnect.timer) end
  M._reconnect.timer, M._reconnect.attempt, M._reconnect.in_progress = nil, 0, false
  pcall(function() require('overleaf.local_compile').stop_watch({ silent = true }) end)
  pcall(function() require('overleaf.cursors').clear_all() end)
  pcall(function() require('overleaf.comments').clear_all() end)
  M._setup_event_handlers()
  config.log('info', 'Opening project: %s', project_name)
  sync.open_workspace(options, function(workspace_error, context)
    if not current() then return end
    if workspace_error then
      config.log('error', '%s', workspace_error.message)
      if workspace_error.code == 'WORKSPACE_BUSY' and sync._failed_workspace then
        local failed = sync._failed_workspace
        vim.schedule(function()
          if not current() then return end
          local ok, err = pcall(require('overleaf.conflicts').locks, failed.params, {
            on_recovered = function() M._connect_project(cookie, project_id, project_name, options) end,
          })
          if not ok then config.log('error', '%s', vim.inspect(err)) end
        end)
      end
      return
    end
    M._state.project_id, M._state.project_name = project_id, project_name
    M._state.documents = context.documents
    M._state.project_data = context.project and context.project.data or nil
    project._project_tree = context.project and vim.deepcopy(context.project.tree) or {}
    bridge._on_unexpected_exit = function(code)
      if not current() then return end
      config.log('warn', 'Bridge exited (code %d); local buffers are retained', code)
      M._state.connected = false
      sync.network_disconnected()
      M._reconnect.attempt = 0
      M._attempt_reconnect()
    end
    local function offline()
      sync.sync_tree(project._project_tree, function()
        if current() then M.open_explorer() end
      end)
    end
    if not cookie or cookie == '' then
      M._state.manual_disconnect = true
      offline()
      return
    end
    local function connect()
      bridge.request('connect', { cookie = cookie, projectId = project_id }, function(err, result)
        if not current() or sync._workspace ~= context then return end
        M._state.manual_disconnect = false
        if err then
          config.log('warn', 'Project is offline: %s', err.message)
          offline()
          return
        end
        context.connected, M._state.connected = true, true
        M._state.project_data = result.project
        project.parse_project_tree(result.project)
        M._save_project_tree(function(metadata_error)
          if not current() then return end
          if metadata_error then
            config.log('error', '%s', metadata_error.message)
            return
          end
          sync.sync_tree(project._project_tree, function(sync_error)
            if not current() then return end
            if sync_error then config.log('warn', '%s', sync_error.message) end
            config.log('info', 'Connected to: %s', project_name)
            require('overleaf.comments').load_threads(project_id)
            M.open_explorer()
            local cfg = config.get().compile or {}
            if cfg.backend == 'local' and cfg.auto_start_watch == true then
              require('overleaf.local_compile').start_watch(M._state)
            end
          end)
        end)
      end)
    end
    if M._state.csrf_token then
      connect()
      return
    end
    bridge.request('auth', { cookie = cookie }, function(auth_error, result)
      if not current() or sync._workspace ~= context then return end
      if auth_error or not result or not result.csrfToken then
        config.log(
          'warn',
          'Project is offline: %s',
          auth_error and auth_error.message or 'Authentication token unavailable'
        )
        offline()
        return
      end
      M._state.csrf_token, M._state.user_id, M._state.user_email = result.csrfToken, result.userId, result.userEmail
      if result.projects then project.set_projects(result.projects) end
      connect()
    end)
  end)
end

function M._setup_event_handlers()
  for name, handler in pairs(M._connection_handlers or {}) do
    bridge.off_event(name, handler)
  end
  M._connection_handlers = {}
  local function on_event(name, handler)
    M._connection_handlers[name] = handler
    bridge.on_event(name, handler)
  end
  local function refresh_tree()
    local context = sync._workspace
    if context then
      M._save_project_tree(function(err)
        if sync._workspace ~= context or context.closing then return end
        if err then
          config.log('error', '%s', err.message)
          return
        end
        sync.sync_tree(project._project_tree, function(sync_error)
          if sync._workspace ~= context or context.closing then return end
          if sync_error then config.log('warn', '%s', sync_error.message) end
        end)
      end)
    end
    vim.schedule(function() require('overleaf.tree').refresh() end)
  end

  on_event('disconnect', function(data)
    if M._state.manual_disconnect then return end
    if M._state.connected then config.log('warn', 'Disconnected: %s — reconnecting...', data.reason or 'unknown') end
    M._state.connected = false
    sync.network_disconnected()
    M._attempt_reconnect()
  end)

  -- File tree events
  on_event('reciveNewDoc', function(data)
    if not data or not data.doc then return end
    local doc_info = data.doc
    local meta = data.meta or {}
    local new_id = doc_info._id or doc_info.id

    -- Normal new doc (not restore)
    local parent_path = project.get_folder_path(data.parentFolderId)
    local path = parent_path .. (doc_info.name or '')
    if sync._workspace and meta.kind == 'file-restore' then
      local previous = project.get_entry_by_path(path)
      if previous and previous.id ~= new_id then project.remove_entry(previous.id) end
    end
    if not project.path_exists(path) then
      local depth = 0
      if data.parentFolderId then
        for _, e in ipairs(project._project_tree) do
          if e.id == data.parentFolderId then
            depth = (e.depth or 0) + 1
            break
          end
        end
      end
      project.add_entry({
        id = new_id,
        name = doc_info.name,
        path = path,
        type = 'doc',
        depth = depth,
      })
    end
    refresh_tree()
  end)

  on_event('reciveNewFile', function(data)
    if not data or not data.file then return end
    local file = data.file
    local parent_path = project.get_folder_path(data.parentFolderId)
    local path = parent_path .. (file.name or '')
    if not project.path_exists(path) then
      local depth = 0
      if data.parentFolderId then
        for _, e in ipairs(project._project_tree) do
          if e.id == data.parentFolderId then
            depth = (e.depth or 0) + 1
            break
          end
        end
      end
      project.add_entry({
        id = file._id or file.id,
        name = file.name,
        path = path,
        type = 'file',
        depth = depth,
      })
    end
    refresh_tree()
  end)

  on_event('removeEntity', function(data)
    if not data or not data.entityId then return end
    local meta = data.meta or {}

    if sync._workspace then
      project.remove_entry_tree(data.entityId)
      refresh_tree()
      return
    end

    -- For file-restore, don't remove the entry — reciveNewDoc will remap it
    if meta.kind == 'file-restore' then
      config.log('debug', 'File restore: old doc %s will be replaced', data.entityId)
      M._pending_restore = M._pending_restore or {}
      M._pending_restore[meta.path or ''] = data.entityId
      return
    end

    project.remove_entry(data.entityId)
    vim.schedule(function() require('overleaf.tree').refresh() end)
  end)

  on_event('reciveEntityRename', function(data)
    if not data or not data.entityId or not data.newName then return end
    project.rename_entry(data.entityId, data.newName)
    refresh_tree()
  end)

  on_event('reciveEntityMove', function(data)
    if not data or not data.entityId then return end
    project.move_entry(data.entityId, data.folderId)
    refresh_tree()
  end)

  on_event('reciveNewFolder', function(data)
    if not data or not data.folder then return end
    local folder = data.folder
    project.add_entry({
      id = folder._id or folder.id,
      name = folder.name,
      type = 'folder',
      path = project.get_folder_path(data.parentFolderId) .. folder.name .. '/',
      depth = project.get_depth_for_parent(data.parentFolderId),
    })
    refresh_tree()
  end)

  on_event('projectNameUpdated', function(data)
    if not data or type(data.name) ~= 'string' then return end
    M._state.project_name = data.name
    if sync._workspace then sync._workspace.name = data.name end
    refresh_tree()
  end)

  on_event('rootDocUpdated', function(data)
    if not data or not data.docId then return end
    M._state.project_data = M._state.project_data or {}
    M._state.project_data.rootDoc_id = data.docId
    refresh_tree()
  end)

  -- Comment events
  local function schedule_feature(callback)
    local context, state, generation = sync._workspace, M._state, M._connection_generation
    vim.schedule(function()
      if sync._workspace == context and M._state == state and M._connection_generation == generation then callback() end
    end)
  end
  local function rerender_comments()
    local comments = require('overleaf.comments')
    for doc_id, doc in pairs(M._state.documents) do
      if doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) and doc.content then
        comments.render(doc.bufnr, doc_id, doc.content)
      end
    end
  end

  on_event('newComment', function(data)
    schedule_feature(function()
      require('overleaf.comments').on_new_comment(data)
      rerender_comments()
    end)
  end)

  on_event('resolveThread', function(data)
    schedule_feature(function()
      require('overleaf.comments').on_resolve_thread(data)
      rerender_comments()
    end)
  end)

  on_event('reopenThread', function(data)
    schedule_feature(function()
      require('overleaf.comments').on_reopen_thread(data)
      rerender_comments()
    end)
  end)

  on_event('deleteThread', function(data)
    schedule_feature(function()
      require('overleaf.comments').on_delete_thread(data)
      rerender_comments()
    end)
  end)

  -- Collaborator cursor tracking
  on_event('clientUpdated', function(data)
    schedule_feature(function() require('overleaf.cursors').on_client_updated(data) end)
  end)

  on_event('clientDisconnected', function(data)
    schedule_feature(function() require('overleaf.cursors').on_client_disconnected(data) end)
  end)
end

-- Auto-reconnect state
M._reconnect = {
  attempt = 0,
  max_attempts = 5,
  timer = nil,
  in_progress = false,
}

function M._attempt_reconnect()
  if M._state.manual_disconnect then return end
  if M._reconnect.in_progress then return end
  if M._state.connected then return end
  if not M._state.project_id then return end -- never connected

  M._reconnect.attempt = M._reconnect.attempt + 1
  if M._reconnect.attempt > M._reconnect.max_attempts then
    config.log('error', 'Reconnect failed after %d attempts', M._reconnect.max_attempts)
    M._reconnect.attempt = 0
    return
  end

  -- Exponential backoff: 2s, 4s, 8s, 16s, 30s
  local delay = math.min(2000 * (2 ^ (M._reconnect.attempt - 1)), 30000)
  config.log(
    'debug',
    'Reconnecting in %ds (attempt %d/%d)...',
    delay / 1000,
    M._reconnect.attempt,
    M._reconnect.max_attempts
  )

  M._reconnect.in_progress = true

  if M._reconnect.timer then vim.fn.timer_stop(M._reconnect.timer) end

  M._reconnect.timer = vim.fn.timer_start(delay, function()
    M._reconnect.timer = nil
    M._do_reconnect()
  end)
end

function M._do_reconnect()
  if M._state.manual_disconnect then return end
  local cookie = config.get().cookie
  if not cookie then
    config.log('error', 'No cookie available for reconnect')
    M._reconnect.in_progress = false
    return
  end

  -- Ensure bridge is running
  if not bridge.is_running() then
    bridge.start(function(err)
      if err then
        config.log('error', 'Failed to restart bridge: %s', err.message)
        M._reconnect.in_progress = false
        M._attempt_reconnect()
        return
      end
      M._setup_event_handlers()
      M._connect_project(cookie, M._state.project_id, M._state.project_name)
    end)
  else
    M._reconnect_to_project(cookie)
  end
end

function M._reconnect_to_project(cookie)
  local context, generation = sync._workspace, M._connection_generation
  M._state.manual_disconnect = true
  bridge.request('connect', {
    cookie = cookie,
    projectId = M._state.project_id,
  }, function(err, result)
    if sync._workspace ~= context or M._connection_generation ~= generation then return end
    M._state.manual_disconnect = false
    M._reconnect.in_progress = false

    if err then
      config.log('debug', 'Reconnect failed: %s', err.message)
      M._attempt_reconnect()
      return
    end

    M._state.connected = true
    M._state.project_data = result.project
    M._reconnect.attempt = 0

    config.log('info', 'Reconnected to: %s', M._state.project_name or '?')
    if context then
      context.connected = true
      project.parse_project_tree(result.project)
      M._save_project_tree(function(metadata_error)
        if sync._workspace ~= context or M._connection_generation ~= generation then return end
        if metadata_error then
          config.log('error', '%s', metadata_error.message)
          return
        end
        sync.connect_documents(function(connection_error)
          if sync._workspace ~= context or M._connection_generation ~= generation then return end
          if connection_error then config.log('warn', '%s', connection_error.message) end
          sync.sync_tree(project._project_tree, function(sync_error)
            if sync._workspace ~= context or M._connection_generation ~= generation then return end
            if sync_error then config.log('warn', '%s', sync_error.message) end
          end)
        end)
      end)
    else
      M._rejoin_documents()
    end
  end)
end

function M._rejoin_documents()
  if sync._workspace then sync.connect_documents() end
end

function M.open_document(doc_id_or_path, doc_path, opts)
  opts = opts or {}
  local doc_id = doc_id_or_path
  local path = doc_path
  local target_win = opts.winid or vim.api.nvim_get_current_win()
  local target_line = tonumber(opts.lnum or opts.line)
  local target_col = tonumber(opts.col)

  local function in_target_window(fn)
    if target_win and vim.api.nvim_win_is_valid(target_win) then
      vim.api.nvim_win_call(target_win, fn)
    else
      fn()
    end
  end

  local function jump_to_target()
    if not target_line or target_line < 1 then return end

    local line_count = vim.api.nvim_buf_line_count(0)
    local line = math.min(target_line, math.max(line_count, 1))
    local col = math.max((target_col or 1) - 1, 0)
    pcall(vim.api.nvim_win_set_cursor, 0, { line, col })
    pcall(vim.cmd, 'normal! zvzz')
  end

  if not path then
    -- Assume it's a path, look up ID
    local info = project.get_doc_by_path(doc_id_or_path)
    if info then
      doc_id = info.id
      path = info.path
    else
      config.log('error', 'Document not found: %s', doc_id_or_path)
      return
    end
  end

  if sync._workspace then
    sync.open_document({ id = doc_id, path = path }, opts, function(err, doc)
      if err then
        config.log('error', '%s', err.message)
        return
      end
      M._state.documents[doc_id] = doc
      in_target_window(jump_to_target)
    end)
    return
  end

  config.log('warn', 'Open a project workspace before opening a document')
end

function M.open_location(location)
  if not location then return end

  local doc_id = location.doc_id or location.id
  local path = location.path or location.file
  if not doc_id and not path then return end

  local opts = {
    bufnr = location.bufnr,
    winid = location.winid,
    lnum = location.lnum or location.line,
    col = location.col,
  }

  if doc_id then
    M.open_document(doc_id, path, opts)
  else
    M.open_document(path, nil, opts)
  end
end

function M.projects()
  bridge.start(function(start_error)
    if start_error then
      config.log('error', '%s', start_error.message)
      return
    end
    bridge.request('syncListProjects', {
      root = vim.fn.stdpath('state') .. '/overleaf/recovery',
      server = config.get().base_url,
    }, function(err, reply)
      if err then config.log('warn', 'Could not read cached projects: %s', err.message) end
      local items, known = {}, {}
      for _, item in ipairs(reply and reply.projects or {}) do
        items[#items + 1], known[item.projectId] = item, true
      end
      for _, item in ipairs(project._projects) do
        if not known[item.id] then items[#items + 1] = { projectId = item.id, name = item.name } end
      end
      if #items == 0 then return M.connect() end
      items[#items + 1] = { name = 'Connect to another project…', connect = true }
      require('overleaf.picker').select(items, {
        prompt = 'Select Overleaf Project:',
        format_item = function(item) return item.name .. (item.sourceRoot and ' (available offline)' or '') end,
      }, function(choice)
        if not choice then return end
        if choice.connect then return M.connect() end
        if M._state.connected and M._state.project_id == choice.projectId then return M.open_explorer() end
        M._connect_project(config.get().cookie, choice.projectId, choice.name, { sourceRoot = choice.sourceRoot })
      end)
    end)
  end)
end

function M.select_project() M.projects() end

function M.select_document()
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected. Run :Overleaf projects first.')
    return
  end

  project.select_document(function(doc_id, doc_path) M.open_document(doc_id, doc_path) end)
end

function M.files(path)
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected. Run :Overleaf projects first.')
    return
  end

  if path and path ~= '' then
    M.open_document(path)
  else
    M.select_document()
  end
end

function M.open_explorer()
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected. Run :Overleaf projects first.')
    return
  end
  require('overleaf.explorer').open()
end

function M.toggle_tree() M.open_explorer() end

function M.open_native_tree()
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected. Run :Overleaf projects first.')
    return
  end
  require('overleaf.tree').toggle()
end

function M.preview_file()
  if not M._state.connected then
    config.log('warn', 'Not connected. Run :Overleaf projects first.')
    return
  end

  -- Get file entries from project tree
  local files = {}
  for _, entry in ipairs(project._project_tree) do
    if entry.type == 'file' then table.insert(files, entry) end
  end

  if #files == 0 then
    config.log('info', 'No binary files in project')
    return
  end

  vim.ui.select(files, {
    prompt = 'Preview file:',
    format_item = function(item) return item.path end,
  }, function(choice)
    if not choice then return end

    config.log('info', 'Downloading %s...', choice.name)
    bridge.request('downloadFile', {
      cookie = config.get().cookie,
      projectId = M._state.project_id,
      fileId = choice.id,
      fileName = choice.name,
      outputDir = config.get().pdf_dir,
    }, function(err, result)
      if err then
        config.log('error', 'Download failed: %s', err.message)
        return
      end
      config.log('info', 'Opening %s', result.path)
      vim.schedule(function() open_file(result.path) end)
    end)
  end)
end

function M.create_doc(name, parent_folder_id)
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local prefix = project.get_folder_path(parent_folder_id)

  local function do_create(doc_name)
    if not doc_name or doc_name == '' then return end

    local full_path = prefix .. doc_name
    require('overleaf.ops').create(full_path, 'file', function(err, entry)
      if err then
        config.log('error', 'Failed to create doc: %s', err)
        return
      end

      config.log('info', 'Created: %s', entry and entry.path or full_path)
    end)
  end

  if name then
    do_create(name)
  else
    vim.ui.input({ prompt = 'New document name: ' }, do_create)
  end
end

function M.create_folder(name, parent_folder_id)
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local prefix = project.get_folder_path(parent_folder_id)

  local function do_create(folder_name)
    if not folder_name or folder_name == '' then return end

    local full_path = prefix .. folder_name .. '/'
    require('overleaf.ops').create(full_path, 'directory', function(err, entry)
      if err then
        config.log('error', 'Failed to create folder: %s', err)
        return
      end

      config.log('info', 'Created folder: %s', entry and entry.path or full_path)
    end)
  end

  if name then
    do_create(name)
  else
    vim.ui.input({ prompt = 'New folder name: ' }, do_create)
  end
end

function M.search(pattern)
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local function do_search(pat)
    if not pat or pat == '' then return end
    require('overleaf.search').grep(pat, M._state)
  end

  if pattern then
    do_search(pattern)
  else
    require('overleaf.search').live(M._state)
  end
end

function M.upload_file(file_path, parent_folder_id)
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local function do_upload(path)
    if not path or path == '' then return end

    -- Expand ~ and resolve
    path = vim.fn.expand(path)
    if vim.fn.filereadable(path) ~= 1 then
      config.log('error', 'File not found: %s', path)
      return
    end

    local file_name = vim.fn.fnamemodify(path, ':t')
    config.log('info', 'Uploading %s...', file_name)

    require('overleaf.ops').upload_file(path, parent_folder_id, function(err, entry)
      if err then
        config.log('error', 'Upload failed: %s', err)
        return
      end
      config.log('info', 'Uploaded: %s', entry and entry.path or file_name)
    end)
  end

  if file_path then
    do_upload(file_path)
  else
    vim.ui.input({ prompt = 'Local file path: ', completion = 'file' }, do_upload)
  end
end

function M.rename_entity()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  -- Show entries to rename
  local entries = {}
  for _, entry in ipairs(project._project_tree) do
    table.insert(entries, entry)
  end

  vim.ui.select(entries, {
    prompt = 'Rename:',
    format_item = function(item) return item.path end,
  }, function(choice)
    if not choice then return end

    vim.ui.input({ prompt = 'New name for "' .. choice.name .. '": ', default = choice.name }, function(new_name)
      if not new_name or new_name == '' or new_name == choice.name then return end

      local dest_path = project.get_parent_path(choice.path) .. new_name
      if choice.type == 'folder' then dest_path = dest_path .. '/' end

      require('overleaf.ops').rename(choice.path, dest_path, function(err, updated)
        if err then
          config.log('error', 'Rename failed: %s', err)
          return
        end
        if updated then config.log('info', 'Renamed to: %s', updated.path) end
      end)
    end)
  end)
end

function M.delete_entity()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  -- Show deletable entries
  local entries = {}
  for _, entry in ipairs(project._project_tree) do
    table.insert(entries, entry)
  end

  vim.ui.select(entries, {
    prompt = 'Delete:',
    format_item = function(item)
      local icon = item.type == 'folder' and '[dir] ' or ''
      return icon .. item.path
    end,
  }, function(choice)
    if not choice then return end

    -- Confirm
    vim.ui.input({ prompt = 'Delete "' .. choice.path .. '"? (y/N): ' }, function(answer)
      if answer ~= 'y' and answer ~= 'Y' then return end

      require('overleaf.ops').delete(choice.path, function(err)
        if err then
          config.log('error', 'Delete failed: %s', err)
          return
        end
        config.log('info', 'Deleted: %s', choice.path)
      end)
    end)
  end)
end

function M.history()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  config.log('info', 'Fetching history...')
  bridge.request('getHistory', {
    cookie = config.get().cookie,
    projectId = M._state.project_id,
  }, function(err, result)
    if err then
      config.log('error', 'History failed: %s', err.message)
      return
    end

    local updates = result.updates or {}
    if #updates == 0 then
      config.log('info', 'No history entries')
      return
    end

    vim.schedule(function() M._show_history(updates) end)
  end)
end

function M._show_history(updates)
  -- Format history entries for display
  local items = {}
  for _, update in ipairs(updates) do
    local users = {}
    for _, u in ipairs(update.meta and update.meta.users or {}) do
      table.insert(users, u.first_name or u.email or '?')
    end

    local ts = update.meta and update.meta.end_ts or 0
    local date = os.date('%Y-%m-%d %H:%M', ts / 1000)

    local files = {}
    for _, p in ipairs(update.pathnames or {}) do
      table.insert(files, p)
    end

    table.insert(items, {
      label = date .. ' | ' .. table.concat(users, ', '),
      detail = table.concat(files, ', '),
      fromV = update.fromV,
      toV = update.toV,
    })
  end

  vim.ui.select(items, {
    prompt = 'Project History:',
    format_item = function(item)
      local detail = item.detail ~= '' and (' (' .. item.detail .. ')') or ''
      return item.label .. detail
    end,
  }, function(choice)
    if not choice then return end
    config.log('info', 'Version range: v%d -> v%d', choice.fromV, choice.toV)
  end)
end

function M.compile()
  local compile_cfg = config.get().compile or {}
  if compile_cfg.backend == 'local' then
    M.compile_local()
    return
  end
  if not M._state.connected then
    config.log('warn', 'Not connected. Run :Overleaf projects first.')
    return
  end

  local context = sync._workspace
  if not context then
    config.log('warn', 'Open a project workspace before compiling')
    return
  end
  local connection = M._connection_generation
  local token = {}
  M._compile_token = token
  local function current()
    return sync._workspace == context
      and not context.closing
      and M._connection_generation == connection
      and M._compile_token == token
  end
  config.log('info', 'Confirming saved revisions before compiling...')
  sync.reconcile(function(reconcile_error)
    if not current() then return end
    if reconcile_error then
      config.log('error', '%s', reconcile_error.message)
      return
    end
    bridge.request('syncCompile', {
      session = context.session,
      cookie = config.get().cookie,
      csrfToken = M._state.csrf_token,
      projectId = M._state.project_id,
    }, function(err, result)
      if not current() then return end
      if err then
        config.log('error', 'Compile failed: %s', err.message)
        return
      end

      if result.status == 'success' then
        config.log('info', 'Compile succeeded')
        -- Auto-download and open PDF
        M._open_pdf(result.outputFiles or {})
      else
        config.log('warn', 'Compile status: %s', result.status)
      end

      vim.schedule(function()
        if current() then M._parse_compile_log(result.log or '') end
      end)
    end)
  end)
end

function M.compile_local()
  local context = sync._workspace
  config.log('info', 'Compiling locally...')

  require('overleaf.local_compile').compile(M._state, function(err, result)
    if sync._workspace ~= context then return end
    if err then
      config.log('error', 'Local compile failed: %s', err.message)
      vim.schedule(function()
        if sync._workspace == context then M._parse_compile_log(err.log or '') end
      end)
      return
    end

    config.log('info', 'Local compile succeeded')
    vim.schedule(function()
      if sync._workspace ~= context then return end
      M._parse_compile_log(result.log or '')
      require('overleaf.local_compile').open_pdf(result.pdf_path)
    end)
  end)
end

function M.compile_watch() require('overleaf.local_compile').start_watch(M._state) end

function M.stop_compile_watch() require('overleaf.local_compile').stop_watch() end

function M._open_pdf(output_files)
  local context, token = sync._workspace, M._compile_token
  local function current() return sync._workspace == context and M._compile_token == token end
  local pdf_file = nil
  for _, f in ipairs(output_files) do
    if f.path == 'output.pdf' then
      pdf_file = f
      break
    end
  end
  if not pdf_file or not pdf_file.url then return end

  local pdf_url = resolve_url(config.get().base_url, pdf_file.url)
  local name = vim.fn.strcharpart((M._state.project_name or 'output'):gsub('[%c/\\]', '_'), 0, 50)
  local identity = vim.fn.sha256(config.get().base_url .. '\n' .. (M._state.project_id or '')):sub(1, 12)
  config.log('debug', 'Downloading PDF from %s', pdf_url)

  bridge.request('downloadUrl', {
    cookie = config.get().cookie,
    url = pdf_url,
    fileName = name .. '-' .. identity .. '.pdf',
    outputDir = config.get().pdf_dir,
  }, function(err, result)
    if not current() then return end
    if err then
      config.log('warn', 'PDF download failed from %s: %s', pdf_url, err.message)
      return
    end
    vim.schedule(function()
      if current() then open_file(result.path) end
    end)
  end)
end

function M._parse_compile_log(log_text)
  local ns = vim.api.nvim_create_namespace('overleaf_compile')

  -- Clear all previous diagnostics
  for _, doc in pairs(M._state.documents) do
    if doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) then vim.diagnostic.set(ns, doc.bufnr, {}) end
  end

  if #log_text == 0 then return end

  -- Build path -> doc lookup
  local path_to_doc = {}
  for _, doc in pairs(M._state.documents) do
    if doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) then
      path_to_doc[doc.path] = doc
      -- Also index without leading path components for relative matches
      local basename = doc.path:match('[^/]+$')
      if basename then path_to_doc[basename] = doc end
    end
  end

  local diagnostics = {} -- bufnr -> list of diagnostics

  -- Track current file via LaTeX log parenthesis-based file tracking
  local file_stack = {}
  local current_file = nil

  local lines = vim.split(log_text, '\n', { plain = true })
  local i = 1
  while i <= #lines do
    local line = lines[i]

    -- Track file opens/closes via parentheses
    for char in line:gmatch('[%(%)][^%(%)]*') do
      if char:sub(1, 1) == '(' then
        local fname = char:sub(2):match('^%s*([^%s%)]+)')
        if fname and fname:match('%.[a-zA-Z]+$') then
          table.insert(file_stack, current_file)
          current_file = fname
        end
      elseif char:sub(1, 1) == ')' then
        current_file = table.remove(file_stack)
      end
    end

    -- Match LaTeX errors: lines starting with "!"
    if line:match('^!') then
      local msg = line:sub(3) -- strip "! "
      local lnum = 0

      -- Look ahead for "l.<number>" line number
      for j = i + 1, math.min(i + 5, #lines) do
        local ln = lines[j]:match('^l%.(%d+)')
        if ln then
          lnum = tonumber(ln) - 1 -- 0-indexed
          break
        end
      end

      local doc = current_file and (path_to_doc[current_file] or path_to_doc[current_file:match('[^/]+$') or ''])
      if doc then
        diagnostics[doc.bufnr] = diagnostics[doc.bufnr] or {}
        table.insert(diagnostics[doc.bufnr], {
          lnum = lnum,
          col = 0,
          severity = vim.diagnostic.severity.ERROR,
          message = msg,
          source = 'latex',
        })
      end
    end

    -- Match LaTeX warnings
    local warn_msg = line:match('LaTeX Warning:%s*(.*)')
    if warn_msg then
      local lnum = 0
      local ln = warn_msg:match('on input line (%d+)')
      if ln then lnum = tonumber(ln) - 1 end

      local doc = current_file and (path_to_doc[current_file] or path_to_doc[current_file:match('[^/]+$') or ''])
      if doc then
        diagnostics[doc.bufnr] = diagnostics[doc.bufnr] or {}
        table.insert(diagnostics[doc.bufnr], {
          lnum = lnum,
          col = 0,
          severity = vim.diagnostic.severity.WARN,
          message = warn_msg,
          source = 'latex',
        })
      end
    end

    -- Match Overfull/Underfull hbox warnings
    local box_msg = line:match('(O[vn][edr][rf][fu][ul]l \\[hv]box.*)')
    if box_msg then
      local lnum = 0
      local ln = line:match('at lines? (%d+)')
      if ln then lnum = tonumber(ln) - 1 end

      local doc = current_file and (path_to_doc[current_file] or path_to_doc[current_file:match('[^/]+$') or ''])
      if doc then
        diagnostics[doc.bufnr] = diagnostics[doc.bufnr] or {}
        table.insert(diagnostics[doc.bufnr], {
          lnum = lnum,
          col = 0,
          severity = vim.diagnostic.severity.HINT,
          message = box_msg,
          source = 'latex',
        })
      end
    end

    i = i + 1
  end

  -- Set diagnostics for each buffer
  for bufnr, diags in pairs(diagnostics) do
    vim.diagnostic.set(ns, bufnr, diags)
  end

  -- Count by severity
  local error_count, warn_count, hint_count = 0, 0, 0
  for _, diags in pairs(diagnostics) do
    for _, d in ipairs(diags) do
      if d.severity == vim.diagnostic.severity.ERROR then
        error_count = error_count + 1
      elseif d.severity == vim.diagnostic.severity.WARN then
        warn_count = warn_count + 1
      else
        hint_count = hint_count + 1
      end
    end
  end

  if error_count > 0 or warn_count > 0 then
    config.log('info', 'Diagnostics: %d error(s), %d warning(s), %d hint(s)', error_count, warn_count, hint_count)
  end
end

function M.refresh_comments()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  require('overleaf.comments').refresh_project_comments(M._state.project_id, function(err)
    if err then config.log('warn', '%s', err.message) end
  end)
end

function M.show_comment()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  -- Find current doc
  local bufnr = vim.api.nvim_get_current_buf()
  local doc_id = nil
  local doc = nil
  for id, d in pairs(M._state.documents) do
    if d.bufnr == bufnr then
      doc_id = id
      doc = d
      break
    end
  end

  if not doc_id then
    config.log('warn', 'Not an Overleaf document')
    return
  end

  local comments = require('overleaf.comments')
  local doc_comments = comments._doc_comments[doc_id]
  local thread_count = vim.tbl_count(comments._threads)
  config.log(
    'debug',
    'show_comment: doc=%s, threads=%d, doc_comments=%d',
    doc_id,
    thread_count,
    doc_comments and #doc_comments or 0
  )

  local thread, _ = comments.get_thread_at_cursor(doc_id, doc.content)
  if thread then
    comments.show_thread(thread)
  else
    config.log(
      'info',
      'No comment at cursor (threads=%d, doc_comments=%d)',
      thread_count,
      doc_comments and #doc_comments or 0
    )
  end
end

function M.list_comments()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end
  require('overleaf.comments').list_all(M._state.project_id)
end

function M.create_comment_from_selection()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local bufnr, doc_id, doc = current_document()
  if not doc_id then
    config.log('warn', 'Not an Overleaf document')
    return
  end
  if not doc.joined then
    config.log('warn', 'Document is not joined yet')
    return
  end

  local selection, selection_err = selected_text_range(bufnr)
  if not selection then
    config.log('warn', selection_err or 'No visual selection')
    return
  end

  if doc.engine and sync._workspace then
    local context, state, tick = sync._workspace, M._state, vim.api.nvim_buf_get_changedtick(bufnr)
    local view = doc.content
    vim.ui.input({ prompt = 'Comment: ' }, function(content)
      if not content or content == '' then return end
      if
        sync._workspace ~= context
        or context.closing
        or M._state ~= state
        or state.documents[doc_id] ~= doc
        or not vim.api.nvim_buf_is_valid(bufnr)
        or vim.api.nvim_buf_get_changedtick(bufnr) ~= tick
      then
        config.log('warn', 'Selection or project changed; select the comment text again')
        return
      end
      bridge.request('syncComment', {
        session = context.session,
        document = doc_id,
        cookie = config.get().cookie,
        csrfToken = state.csrf_token,
        selection = {
          thread = generate_comment_thread_id(),
          message = content,
          view = view,
          start = selection.start,
          ['end'] = selection.finish,
        },
      }, function(err)
        if sync._workspace ~= context or context.closing or M._state ~= state then return end
        if doc.controller then doc.controller:refresh() end
        if err then
          config.log('error', '%s', err.message)
          return
        end
        config.log('info', 'Comment posted; synchronizing its text range')
        local comments = require('overleaf.comments')
        comments.load_threads(state.project_id, function(failure)
          if not failure then comments.refresh_document(doc) end
        end)
      end)
    end)
    return
  end

  config.log('warn', 'Open an owned workspace document before commenting')
end

function M.comment_drafts()
  local buf, id, doc = current_document()
  local context = sync._workspace
  if not context or not doc or not doc.engine then
    config.log('warn', 'Open an Overleaf source first')
    return
  end
  local selection = selected_text_range(buf)
  local view, tick = doc.content, vim.api.nvim_buf_get_changedtick(buf)
  require('overleaf.comments').review_drafts(doc, context, selection and {
    view = view,
    start = selection.start,
    ['end'] = selection.finish,
    current = function()
      return sync._workspace == context
        and context.documents[id] == doc
        and vim.api.nvim_buf_is_valid(buf)
        and vim.api.nvim_buf_get_changedtick(buf) == tick
    end,
  } or nil)
end

function M.reply_comment()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()
  local doc_id = nil
  local doc = nil
  for id, d in pairs(M._state.documents) do
    if d.bufnr == bufnr then
      doc_id = id
      doc = d
      break
    end
  end

  if not doc_id then
    config.log('warn', 'Not an Overleaf document')
    return
  end

  local comments = require('overleaf.comments')
  local thread = comments.get_thread_at_cursor(doc_id, doc.content)
  if not thread then
    config.log('info', 'No comment at cursor')
    return
  end

  local state, context, generation = M._state, sync._workspace, M._connection_generation
  local function current()
    return M._state == state
      and state.connected
      and M._connection_generation == generation
      and sync._workspace == context
      and state.documents[doc_id] == doc
  end
  vim.ui.input({ prompt = 'Reply: ' }, function(content)
    if not content or content == '' or not current() then return end

    bridge.request('addComment', {
      cookie = config.get().cookie,
      csrfToken = M._state.csrf_token,
      projectId = M._state.project_id,
      threadId = thread.id,
      content = content,
    }, function(err, _)
      if not current() then return end
      if err then
        config.log('error', 'Reply failed: %s', err.message)
        return
      end
      config.log('info', 'Reply added')
    end)
  end)
end

function M.resolve_comment()
  if not M._state.connected then
    config.log('warn', 'Not connected.')
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()
  local doc_id = nil
  local doc = nil
  for id, d in pairs(M._state.documents) do
    if d.bufnr == bufnr then
      doc_id = id
      doc = d
      break
    end
  end

  if not doc_id then
    config.log('warn', 'Not an Overleaf document')
    return
  end

  local comments = require('overleaf.comments')
  local thread = comments.get_thread_at_cursor(doc_id, doc.content)
  if not thread then
    config.log('info', 'No comment at cursor')
    return
  end

  config.log('debug', 'resolve_comment: threadId=%s resolved=%s', thread.id, tostring(thread.resolved))

  local state, context = M._state, sync._workspace
  local function current() return M._state == state and sync._workspace == context and state.documents[doc_id] == doc end
  if thread.resolved then
    bridge.request('reopenThread', {
      cookie = config.get().cookie,
      csrfToken = M._state.csrf_token,
      projectId = M._state.project_id,
      docId = doc_id,
      threadId = thread.id,
    }, function(err, _)
      if not current() then return end
      if err then
        config.log('error', 'Reopen failed: %s', err.message)
        return
      end
      thread.resolved = false
      config.log('info', 'Thread reopened')
      vim.schedule(function() comments.render(bufnr, doc_id, doc.content) end)
    end)
  else
    bridge.request('resolveThread', {
      cookie = config.get().cookie,
      csrfToken = M._state.csrf_token,
      projectId = M._state.project_id,
      docId = doc_id,
      threadId = thread.id,
    }, function(err, _)
      if not current() then return end
      if err then
        config.log('error', 'Resolve failed: %s', err.message)
        return
      end
      thread.resolved = true
      config.log('info', 'Thread resolved')
      vim.schedule(function() comments.render(bufnr, doc_id, doc.content) end)
    end)
  end
end

function M.sync_all()
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected.')
    return
  end
  sync.sync_all(M._state, project._project_tree)
end

function M.sync_import()
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected.')
    return
  end
  sync.import_all(M._state)
end

function M.sync_export()
  if not M._state.connected and not sync._workspace then
    config.log('warn', 'Not connected.')
    return
  end
  sync.export_all(M._state)
end

--- Select both sides explicitly: legacy names never establish project identity.
function M.migrate(directory, callback)
  local context, capture = sync._workspace, nil
  local function done(err, doc)
    if capture then
      capture.keep = err ~= nil
      require('overleaf.editor.history').dispose(capture)
    end
    if callback then return callback(err, doc) end
    if err then
      config.log('error', '%s', type(err) == 'table' and err.message or tostring(err))
    elseif doc then
      config.log('info', 'Legacy version retained. Use :Overleaf resolve to review it before syncing.')
    end
  end
  if not context then return done({ message = 'Open the destination project before migration' }) end
  local function current() return sync._workspace == context and not context.closing end
  local function choose_target(source)
    if not current() then return done({ message = 'Project changed during migration' }) end
    local targets = vim.tbl_filter(function(entry) return entry.type == 'doc' end, project._project_tree or {})
    if #targets == 0 then return done({ message = 'The destination project has no text documents' }) end
    vim.ui.select(targets, {
      prompt = 'Import into project ' .. context.params.projectId .. ' at ' .. context.params.server .. ':',
      format_item = function(entry) return entry.path .. ' [' .. entry.id .. ']' end,
    }, function(target)
      if not target then return done() end
      if not current() then return done({ message = 'Project changed during migration' }) end
      sync.open_document(target, {}, function(err, doc)
        if err then return done(err) end
        if not current() then return done({ message = 'Project changed during migration' }) end
        local ok, result = pcall(function()
          if capture then source.checkpoint = require('overleaf.editor.history').checkpoint(capture) end
          return doc.controller:import_branch(source)
        end)
        if not ok then return done(result) end
        if not current() then
          return done({ message = 'Project changed; the imported branch remains in its recovery store' })
        end
        M._state.documents[doc.doc_id] = doc
        done(nil, doc)
      end)
    end)
  end
  local function choose_source(inventory)
    if not current() then return done({ message = 'Project changed during migration' }) end
    local choices = {}
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      local name = vim.api.nvim_buf_get_name(buf)
      if vim.api.nvim_buf_is_loaded(buf) and name:match('^overleaf://') and not vim.b[buf].overleaf_qf_placeholder then
        choices[#choices + 1] = { kind = 'buffer', buf = buf, name = name }
      end
    end
    for _, entry in ipairs(inventory and inventory.entries or {}) do
      if entry.type ~= 'directory' then
        choices[#choices + 1] = { kind = 'file', name = entry.path, filename = entry.filename, type = entry.type }
      end
    end
    if #choices == 0 then
      return done({ message = 'No legacy sources found; use :Overleaf migrate /old/project/directory' })
    end
    vim.ui.select(choices, {
      prompt = 'Select a legacy source (originals are retained):',
      format_item = function(entry) return '[' .. (entry.type or entry.kind) .. '] ' .. entry.name end,
    }, function(choice)
      if not choice then return done() end
      if not current() then return done({ message = 'Project changed during migration' }) end
      if choice.kind == 'file' then
        if choice.type ~= 'file' then return done({ message = 'Only ordinary text files can be imported' }) end
        bridge.request('syncLegacyRead', { filename = choice.filename }, function(err, source)
          if err then return done(err) end
          choose_target(source)
        end)
      else
        local ok, result = pcall(require('overleaf.editor.history').capture, choice.buf, {
          directory = context.directory .. '/editor-captures',
          document = 'legacy:' .. choice.name,
        })
        if not ok then return done(result) end
        capture = result
        choose_target({ kind = 'buffer', name = choice.name })
      end
    end)
  end
  if directory then
    bridge.request(
      'syncLegacyInventory',
      { directory = vim.fn.fnamemodify(vim.fn.expand(directory), ':p'):gsub('/$', '') },
      function(err, inventory)
        if err then return done(err) end
        choose_source(inventory)
      end
    )
  else
    choose_source()
  end
end

local function present(value) return value ~= nil and value ~= vim.NIL end

local function document_state(doc) return (doc.controller and doc.controller.state) or doc.state or {} end

local function held_reason(doc)
  local state = document_state(doc)
  if present(state.lifecycle) then return state.lifecycle.reason end
  if present(state.conflict) then return state.conflict.reason or 'conflict' end
  if present(state.held) then return state.held.reason end
  if present(state.disk) and present(state.disk.held) then return state.disk.held.reason end
  if present(state.transport) and state.transport.state == 'held' then return state.transport.reason end
  if doc.scan_error or doc.transport_error then return (doc.scan_error or doc.transport_error).code end
end

local function document_status(doc)
  local state = document_state(doc)
  local local_status = doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) and vim.bo[doc.bufnr].modified and 'unsaved'
    or 'saved locally'
  local network = not M._state.connected and 'offline' or state.publication or 'connecting'
  if state.publication == 'local-only' then network = 'local only' end
  if network == 'pending' then network = 'awaiting sync' end
  local reason = held_reason(doc)
  return local_status .. ' | ' .. network .. (reason and (' | held: ' .. reason) or '')
end

function M.resolve(kind)
  local _, _, doc = current_document()
  if not doc or not doc.controller then
    config.log('warn', 'Open a workspace document before resolving it')
    return
  end
  local conflicts = require('overleaf.conflicts')
  local state = document_state(doc)
  local action = kind == 'history' and conflicts.history
    or kind == 'disk-history' and conflicts.disk_history
    or kind == 'recovery' and conflicts.recovery
  if not action then
    if present(state.lifecycle) and present(state.lifecycle.remotePath) then
      action = function(controller)
        return conflicts.relocation(controller, {
          accept = function(review) return sync.relocate_document(doc, review) end,
          local_choices = {
            accept = function(review) return sync.keep_document_local(doc, review) end,
            archive = function(review) return sync.relocate_document(doc, review, true) end,
          },
        })
      end
    elseif present(state.lifecycle) then
      action = function(controller)
        return conflicts.lifecycle(controller, {
          accept = function(review) return sync.keep_document_local(doc, review) end,
          archive = function(review) return sync.relocate_document(doc, review, true) end,
        })
      end
    elseif present(state.conflict) then
      action = state.publication == 'uncertain'
          and function(controller)
            return conflicts.upload(controller, {
              detach = function(review) return sync.keep_document_local(doc, review, true) end,
            })
          end
        or conflicts.resolve
    elseif present(state.held) and state.held.reason == 'history-conflict' then
      action = conflicts.history
    elseif present(state.disk) and present(state.disk.held) then
      action = conflicts.recovery
    end
  end
  if not action then
    config.log(
      'warn',
      'No text conflict is ready for resolution%s',
      held_reason(doc) and (': ' .. held_reason(doc)) or ''
    )
    return
  end
  local ok, view = pcall(action, doc.controller)
  if not ok then
    config.log('error', '%s', vim.inspect(view))
    return
  end
  if kind == 'codediff' and view and view.open_codediff then
    local opened, err = pcall(view.open_codediff, view)
    if not opened then config.log('warn', '%s; native review remains available', vim.inspect(err)) end
  end
  return view
end

function M.recover(kind)
  if kind ~= 'locks' then return M.resolve('recovery') end
  local failed = sync._failed_workspace
  if not failed then
    config.log('info', 'No failed project ownership to review')
    return
  end
  return require('overleaf.conflicts').locks(failed.params, {
    on_recovered = function() M._connect_project(config.get().cookie, failed.options.projectId, failed.options.name) end,
  })
end

function M.conflicts()
  local context = sync._workspace
  if not context then
    config.log('info', 'No active workspace')
    return
  end
  local items = {}
  for _, doc in pairs(context.documents) do
    local reason = held_reason(doc)
    if reason then items[#items + 1] = { label = doc.path .. ': ' .. reason, doc = doc } end
  end
  for _, asset in pairs(context.assets) do
    if present(asset.state.lifecycle) or (asset.state.status ~= 'synced' and asset.state.status ~= 'local-only') then
      items[#items + 1] = { label = asset.state.path .. ': ' .. asset.state.status, asset = asset }
    end
  end
  table.sort(items, function(a, b) return a.label < b.label end)
  if #items == 0 then
    config.log('info', 'No held documents or binary changes')
    return
  end
  vim.ui.select(
    items,
    { prompt = 'Overleaf conflicts:', format_item = function(item) return item.label end },
    function(item)
      if not item or sync._workspace ~= context then return end
      if item.asset then
        bridge.request(
          'syncAsset',
          { session = context.session, document = item.asset.document, path = item.asset.state.path },
          function(err, review)
            if err then
              config.log('error', '%s', err.message)
              return
            end
            if sync._workspace ~= context then return end
            require('overleaf.conflicts').asset(review, {
              on_resolved = function(result)
                if sync._workspace == context then
                  context.assets[result.document] = result
                  context.asset_sources[result.document] = result.state.path
                end
              end,
            })
          end
        )
      else
        sync.open_document({ id = item.doc.doc_id, path = item.doc.path }, {}, function(err)
          if err then
            config.log('error', '%s', err.message)
            return
          end
          M.resolve()
        end)
      end
    end
  )
end

function M.disconnect()
  M._connection_generation = (M._connection_generation or 0) + 1
  -- Stop auto-reconnect
  M._reconnect.attempt = 0
  M._reconnect.in_progress = false
  if M._reconnect.timer then
    vim.fn.timer_stop(M._reconnect.timer)
    M._reconnect.timer = nil
  end
  bridge._on_unexpected_exit = nil
  M._state.manual_disconnect = true

  pcall(function() require('overleaf.local_compile').stop_watch({ silent = true }) end)

  if sync._workspace then
    M._state.connected = false
    sync.network_disconnected()
    pcall(function() require('overleaf.cursors').clear_all() end)
    pcall(function() require('overleaf.comments').clear_all() end)
    bridge.request('disconnect', {}, function(err)
      if err then config.log('error', '%s', err.message) end
    end)
    config.log('info', 'Offline; local editing and saving remain available')
    return
  end

  -- Stop file sync watchers
  sync.stop()

  -- Clear collaborator cursors and comments
  pcall(function() require('overleaf.cursors').clear_all() end)
  pcall(function() require('overleaf.comments').clear_all() end)

  -- Legacy buffers remain available for explicit migration.
  M._state.documents = {}

  -- Disconnect bridge
  bridge.stop()

  M._state.connected = false
  M._state.project_name = nil
  M._state.project_id = nil
  M._state.project_data = nil
  M._state.csrf_token = nil
  M._state.user_id = nil
  M._state.user_email = nil

  config.log('info', 'Disconnected')
end

function M.status()
  if sync._workspace then
    config.log(
      'info',
      'Project: %s | %s',
      M._state.project_name or '?',
      M._state.connected and 'connected' or 'offline'
    )
    for _, doc in pairs(sync._workspace.documents) do
      config.log('info', '  %s: %s', doc.path, document_status(doc))
    end
    for _, asset in pairs(sync._workspace.assets) do
      config.log('info', '  %s: %s', asset.state.path, asset.state.status)
    end
    return
  end
  if not M._state.connected then
    config.log('info', 'Not connected')
    return
  end

  local doc_count = 0
  for _ in pairs(M._state.documents) do
    doc_count = doc_count + 1
  end

  config.log(
    'info',
    'Project: %s | Documents: %d | Connected: %s',
    M._state.project_name or '?',
    doc_count,
    M._state.connected and 'yes' or 'no'
  )

  for _, doc in pairs(M._state.documents) do
    config.log('info', '  - %s (v%d)', doc.path, doc.version or 0)
  end
end

--- Statusline component for lualine or custom statusline
--- Usage with lualine: sections = { lualine_x = { require('overleaf').statusline } }
function M.statusline()
  if sync._workspace then
    local _, _, doc = current_document()
    local prefix = 'OL: ' .. (M._state.project_name or sync._workspace.name or '?')
    return prefix
      .. (doc and (' / ' .. doc.path .. ' | ' .. document_status(doc)) or (M._state.connected and '' or ' | offline'))
  end
  if not M._state.connected then return '' end

  local proj = M._state.project_name or '?'

  -- Show current doc name if in an overleaf buffer
  local bufname = vim.api.nvim_buf_get_name(0)
  local doc_path = sync.parse_buf_name(bufname)
  if doc_path then return 'OL: ' .. proj .. ' / ' .. doc_path end

  return 'OL: ' .. proj
end

return M
