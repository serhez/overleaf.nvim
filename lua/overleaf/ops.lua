local bridge = require('overleaf.bridge')
local config = require('overleaf.config')
local project = require('overleaf.project')
local sync = require('overleaf.sync')

local M = {}

local sync_in_progress = false
local sync_waiters = {}

local function state() return require('overleaf')._state end

local function clean_path(path)
  path = path or ''
  path = path:gsub('^/+', '')
  path = path:gsub('/+', '/')
  return path
end

local function validate_path(path, opts)
  opts = opts or {}
  path = clean_path(path)

  if path == '' then return nil, 'Path cannot be empty' end
  if path:match('^%.%.?$') or path:match('/%.%.?/') or path:match('/%.%.?$') or path:match('^%.%.?/') then
    return nil, 'Path cannot contain . or .. components: ' .. path
  end
  if path:find('\0', 1, true) then return nil, 'Path cannot contain NUL bytes' end
  if path:match('//') then return nil, 'Path cannot contain empty components: ' .. path end

  local components = vim.split(path:gsub('/+$', ''), '/', { plain = true, trimempty = true })
  for _, component in ipairs(components) do
    if component == '' then
      return nil, 'Path cannot contain empty components: ' .. path
    end
    if component:find('\n', 1, true) or component:find('\r', 1, true) then
      return nil, 'Path cannot contain newlines: ' .. path
    end
  end

  if opts.kind == 'name' and #components ~= 1 then
    return nil, 'Name cannot contain /: ' .. path
  end

  return path
end

local function strip_trailing_slash(path)
  if path ~= '/' then path = path:gsub('/+$', '') end
  return path
end

local function basename(path)
  path = strip_trailing_slash(clean_path(path))
  return path:match('([^/]+)$') or path
end

local function local_path(doc_path)
  local dir = sync.dir()
  if not dir then return nil end
  return dir .. '/' .. clean_path(doc_path)
end

local function mkdir_parent(path)
  path = strip_trailing_slash(path)
  local dir = vim.fn.fnamemodify(path, ':h')
  vim.fn.mkdir(dir, 'p')
end

local function update_tree_views()
  pcall(function() require('overleaf.tree').refresh() end)
end

local function request(method, params, callback)
  bridge.request(method, params, function(err, result)
    if err then
      callback(err.message or tostring(err))
    else
      callback(nil, result)
    end
  end)
end

local function auth_params()
  local ol_state = state()
  return {
    cookie = config.get().cookie,
    csrfToken = ol_state.csrf_token,
    projectId = ol_state.project_id,
  }
end

local function ensure_connected(callback)
  if not state().connected then
    callback('Not connected to an Overleaf project')
    return false
  end
  return true
end

function M.sync_project(callback)
  callback = callback or function() end
  if not ensure_connected(callback) then return end
  if sync_in_progress then
    table.insert(sync_waiters, callback)
    return
  end

  sync_in_progress = true
  sync.sync_all(state(), project._project_tree, function()
    sync_in_progress = false
    callback()
    local waiters = sync_waiters
    sync_waiters = {}
    for _, waiter in ipairs(waiters) do
      waiter()
    end
  end)
end

function M.get_sync_dir() return sync.dir() end

function M.local_path(path) return local_path(path) end

function M.can_use_local_mirror()
  return sync.dir() ~= nil
end

function M.create(path, entry_type, callback)
  callback = callback or function() end
  if not ensure_connected(callback) then return end

  local path_err
  path, path_err = validate_path(path)
  if not path then
    callback(path_err)
    return
  end

  local is_dir = entry_type == 'directory' or path:sub(-1) == '/'
  local normalized_path = is_dir and (strip_trailing_slash(path) .. '/') or path
  if project.path_exists(normalized_path) then
    callback('Already exists: ' .. normalized_path)
    return
  end

  local parent_folder_id = project.get_parent_folder_id(normalized_path)
  local name = basename(normalized_path)
  local params = auth_params()
  params.name = name
  params.parentFolderId = parent_folder_id

  local method = is_dir and 'createFolder' or 'createDoc'
  request(method, params, function(err, result)
    if err then
      callback(err)
      return
    end

    local entry = {
      id = result and (result._id or result.id) or nil,
      name = name,
      path = normalized_path,
      type = is_dir and 'folder' or 'doc',
      depth = project.get_depth_for_parent(parent_folder_id),
    }
    if entry.id then project.add_entry(entry) end

    local dest = local_path(normalized_path)
    if dest then
      if is_dir then
        vim.fn.mkdir(dest, 'p')
      else
        mkdir_parent(dest)
        if vim.fn.filereadable(dest) == 0 then vim.fn.writefile({}, dest) end
      end
    end

    update_tree_views()
    callback(nil, entry)
  end)
end

local function update_open_doc_after_rename(doc_id, new_path)
  local ol_state = state()
  local doc = ol_state.documents[doc_id]
  if not doc then return end

  sync.unwatch(doc)
  doc.path = new_path
  if doc.bufnr and vim.api.nvim_buf_is_valid(doc.bufnr) then
    pcall(vim.api.nvim_buf_set_name, doc.bufnr, sync.buf_name(new_path))
  end
  sync.watch(doc)
end

function M.rename(src_path, dest_path, callback)
  callback = callback or function() end
  if not ensure_connected(callback) then return end

  local path_or_err
  src_path, path_or_err = validate_path(src_path)
  if not src_path then
    callback(path_or_err)
    return
  end
  dest_path, path_or_err = validate_path(dest_path)
  if not dest_path then
    callback(path_or_err)
    return
  end

  local entry = project.get_entry_by_path(src_path) or project.get_entry_by_path(src_path .. '/')
  if not entry then
    callback('Not found: ' .. src_path)
    return
  end

  local normalized_dest = entry.type == 'folder' and (strip_trailing_slash(dest_path) .. '/') or dest_path
  if project.get_parent_path(entry.path) ~= project.get_parent_path(normalized_dest) then
    callback('Moving between folders is not supported yet')
    return
  end
  if project.path_exists(normalized_dest) then
    callback('Already exists: ' .. normalized_dest)
    return
  end

  local affected_docs = {}
  if entry.type == 'folder' then
    for _, child in ipairs(project._project_tree) do
      if child.type == 'doc' and child.path:sub(1, #entry.path) == entry.path then
        affected_docs[child.id] = child.path
      end
    end
  elseif entry.type == 'doc' then
    affected_docs[entry.id] = entry.path
  end

  for doc_id in pairs(affected_docs) do
    local doc = state().documents[doc_id]
    if doc then sync.unwatch(doc) end
  end

  local params = auth_params()
  params.entityId = entry.id
  params.entityType = entry.type
  params.newName = basename(normalized_dest)

  request('renameEntity', params, function(err)
    if err then
      for doc_id in pairs(affected_docs) do
        local doc = state().documents[doc_id]
        if doc then sync.watch(doc) end
      end
      callback(err)
      return
    end

    local old_path = entry.path
    local updated = project.rename_entry(entry.id, params.newName)

    local old_local = local_path(old_path)
    local new_local = local_path(normalized_dest)
    if old_local and new_local and vim.fn.filereadable(old_local) + vim.fn.isdirectory(old_local) > 0 then
      mkdir_parent(new_local)
      pcall(vim.fn.rename, old_local, new_local)
    end

    if updated then
      if entry.type == 'folder' then
        for doc_id, previous_path in pairs(affected_docs) do
          local new_doc_path = normalized_dest .. previous_path:sub(#old_path + 1)
          update_open_doc_after_rename(doc_id, new_doc_path)
        end
      elseif entry.type == 'doc' then
        update_open_doc_after_rename(entry.id, updated.path)
      end
    end

    update_tree_views()
    callback(nil, updated)
  end)
end

function M.delete(path, callback)
  callback = callback or function() end
  if not ensure_connected(callback) then return end

  local path_or_err
  path, path_or_err = validate_path(path)
  if not path then
    callback(path_or_err)
    return
  end

  local entry = project.get_entry_by_path(path) or project.get_entry_by_path(path .. '/')
  if not entry then
    callback('Not found: ' .. path)
    return
  end

  local params = auth_params()
  params.entityId = entry.id
  params.entityType = entry.type

  request('deleteEntity', params, function(err)
    if err then
      callback(err)
      return
    end

    local removed = project.remove_entry_tree(entry.id)
    for _, removed_entry in ipairs(removed) do
      if removed_entry.type == 'doc' then
        local doc = state().documents[removed_entry.id]
        if doc then
          sync.unwatch(doc)
          doc:leave(function() require('overleaf.buffer').cleanup(doc) end)
          state().documents[removed_entry.id] = nil
        end
      end
    end

    local target = local_path(entry.path)
    if target then
      if entry.type == 'folder' then
        pcall(vim.fn.delete, target, 'rf')
      else
        pcall(vim.fn.delete, target)
      end
    end

    update_tree_views()
    callback(nil, removed)
  end)
end

function M.upload_file(file_path, parent_folder_id, callback)
  callback = callback or function() end
  if not ensure_connected(callback) then return end

  file_path = vim.fn.expand(file_path or '')
  if file_path == '' then
    callback('File path cannot be empty')
    return
  end
  if vim.fn.filereadable(file_path) ~= 1 then
    callback('File not found: ' .. file_path)
    return
  end

  local file_name = vim.fn.fnamemodify(file_path, ':t')
  local validated_name, name_err = validate_path(file_name, { kind = 'name' })
  if not validated_name then
    callback(name_err)
    return
  end

  local parent_path = project.get_folder_path(parent_folder_id)
  local remote_path = parent_path .. file_name
  if project.path_exists(remote_path) then
    callback('Already exists: ' .. remote_path)
    return
  end

  local params = auth_params()
  params.filePath = file_path
  params.fileName = file_name
  params.parentFolderId = parent_folder_id

  request('uploadFile', params, function(err, result)
    if err then
      callback(err)
      return
    end

    local entry = {
      id = result and (result._id or result.id or result.fileId),
      name = file_name,
      path = remote_path,
      type = 'file',
      depth = project.get_depth_for_parent(parent_folder_id),
    }
    if entry.id then project.add_entry(entry) end

    local dest = local_path(remote_path)
    if dest then
      mkdir_parent(dest)
      local ok, data = pcall(vim.fn.readfile, file_path, 'b')
      if ok then pcall(vim.fn.writefile, data, dest, 'b') end
    end

    update_tree_views()
    callback(nil, entry)
  end)
end

function M.copy(_src_path, _dest_path, callback)
  callback = callback or function() end
  callback('Copy is not supported by the Overleaf explorer yet')
end

M._validate_path = validate_path

return M
