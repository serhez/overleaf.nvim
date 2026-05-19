local ops = require('overleaf.ops')
local project = require('overleaf.project')

local M = {}

local SCHEME = 'canola-overleaf://'

local function constants()
  return require('canola.constants')
end

local function cache()
  return require('canola.cache')
end

local function util()
  return require('canola.util')
end

local function clean_adapter_path(path)
  path = path or '/'
  path = path:gsub('^/+', '')
  if path == '' then return '' end
  if path:sub(-1) == '/' then return path end
  local entry = project.get_entry_by_path(path)
  if entry and entry.type == 'folder' then return path .. '/' end
  return path
end

local function url_to_project_path(url)
  local _, path = util().parse_url(url)
  return clean_adapter_path(path)
end

local function project_path_to_url(path)
  return SCHEME .. '/' .. clean_adapter_path(path)
end

local function with_meta(entry, overleaf_entry)
  local c = constants()
  entry[c.FIELD_META] = {
    overleaf = {
      id = overleaf_entry.id,
      path = overleaf_entry.path,
      type = overleaf_entry.type,
    },
  }
  return entry
end

function M.normalize_url(url, callback)
  local path = url_to_project_path(url)
  if path == '' then
    callback(SCHEME .. '/')
    return
  end

  local entry = project.get_entry_by_path(path) or project.get_entry_by_path(path .. '/')
  if entry and entry.type == 'folder' then
    callback(project_path_to_url(entry.path))
    return
  end

  if entry and entry.type == 'doc' then
    callback(project_path_to_url(entry.path))
    return
  end

  local file_path = ops.local_path(path)
  if file_path then
    callback(file_path)
  else
    callback(url)
  end
end

function M.get_parent(bufname)
  local path = url_to_project_path(bufname)
  local parent = project.get_parent_path(path)
  return project_path_to_url(parent)
end

function M.get_entry_path(url, entry, callback)
  local path = url_to_project_path(url)
  if entry.name == '..' then
    callback(project_path_to_url(project.get_parent_path(path)))
    return
  end

  if entry.type == 'directory' then
    callback(project_path_to_url(path))
    return
  end

  local overleaf_entry = project.get_entry_by_path(path)
  if overleaf_entry and overleaf_entry.type == 'doc' then
    callback(project_path_to_url(overleaf_entry.path))
    return
  end

  ops.sync_project(function()
    local file_path = ops.local_path(path)
    if file_path then
      callback(file_path)
    else
      callback(url)
    end
  end)
end

function M.list(url, _column_defs, callback)
  local parent_path = url_to_project_path(url)
  ops.sync_project(function(err)
    if err then
      callback(err)
      return
    end

    local entries = {}
    for _, child in ipairs(project.direct_children(parent_path)) do
      local entry_type = child.type == 'folder' and 'directory' or 'file'
      local entry = cache().create_entry(url, child.name, entry_type)
      table.insert(entries, with_meta(entry, child))
    end
    callback(nil, entries)
  end)
end

function M.is_modifiable(_bufnr) return true end

function M.get_column(_name) return nil end

function M.render_action(action)
  if action.type == 'create' or action.type == 'delete' then
    return string.format('%s %s', action.type:upper(), url_to_project_path(action.url))
  elseif action.type == 'move' or action.type == 'copy' then
    return string.format(
      '%s %s -> %s',
      action.type:upper(),
      url_to_project_path(action.src_url),
      url_to_project_path(action.dest_url)
    )
  else
    return tostring(action.type)
  end
end

function M.perform_action(action, callback)
  if not ops.can_use_local_mirror() then
    callback('Overleaf canola explorer requires overleaf.nvim sync_dir')
    return
  end

  if action.type == 'create' then
    ops.create(url_to_project_path(action.url), action.entry_type, callback)
  elseif action.type == 'delete' then
    ops.delete(url_to_project_path(action.url), callback)
  elseif action.type == 'move' then
    ops.rename(url_to_project_path(action.src_url), url_to_project_path(action.dest_url), callback)
  elseif action.type == 'copy' then
    ops.copy(url_to_project_path(action.src_url), url_to_project_path(action.dest_url), callback)
  else
    callback('Unsupported Overleaf explorer action: ' .. tostring(action.type))
  end
end

function M.filter_action(action)
  if action.type == 'change' then return false end
  return true
end

function M.read_file(bufnr)
  local path = url_to_project_path(vim.api.nvim_buf_get_name(bufnr))
  local entry = project.get_entry_by_path(path)

  if entry and entry.type == 'doc' and not vim.b[bufnr].canola_preview_buffer then
    vim.bo[bufnr].bufhidden = 'wipe'
    vim.bo[bufnr].buflisted = false
    vim.bo[bufnr].buftype = 'nofile'
    vim.bo[bufnr].swapfile = false
    vim.bo[bufnr].modifiable = true
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { 'Opening Overleaf document...' })
    vim.bo[bufnr].modified = false

    local winid = vim.fn.bufwinid(bufnr)
    vim.schedule(function()
      require('overleaf').open_document(entry.id, entry.path, { winid = winid ~= -1 and winid or nil })
    end)
    return
  end

  local file_path = ops.local_path(path)
  if not file_path then return end

  local lines = {}
  if vim.fn.filereadable(file_path) == 1 then lines = vim.fn.readfile(file_path) end
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modified = false
end

function M.write_file(bufnr)
  local path = url_to_project_path(vim.api.nvim_buf_get_name(bufnr))
  local file_path = ops.local_path(path)
  if not file_path then return end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  vim.fn.mkdir(vim.fn.fnamemodify(file_path, ':h'), 'p')
  vim.fn.writefile(lines, file_path)
  vim.bo[bufnr].modified = false
end

return M
