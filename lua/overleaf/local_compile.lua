local config = require('overleaf.config')
local project = require('overleaf.project')
local sync = require('overleaf.sync')

local M = {}

M._watch_job_id = nil

local function compile_config()
  local cfg = config.get().compile
  if type(cfg) ~= 'table' then cfg = {} end
  return cfg
end

local function shell_join(command)
  if type(command) == 'table' then
    local parts = {}
    for _, part in ipairs(command) do
      table.insert(parts, vim.fn.shellescape(part))
    end
    return table.concat(parts, ' ')
  end
  return tostring(command or '')
end

local function build_command(command, main_file)
  if type(command) == 'table' then
    local result = {}
    local replaced = false
    for _, part in ipairs(command) do
      local value = tostring(part):gsub('{main}', main_file)
      if value ~= part then replaced = true end
      table.insert(result, value)
    end
    if not replaced then table.insert(result, main_file) end
    return result
  end

  command = tostring(command or '')
  if command:find('{main}', 1, true) then
    return command:gsub('{main}', vim.fn.shellescape(main_file))
  end
  return command .. ' ' .. vim.fn.shellescape(main_file)
end

local function find_main_file(state)
  local cfg = compile_config()
  if cfg.main_file and cfg.main_file ~= '' then return cfg.main_file end

  local project_data = state and state.project_data or {}
  local root_doc_id = project_data.rootDoc_id or project_data.rootDocId or project_data.rootDoc
  if type(root_doc_id) == 'table' then root_doc_id = root_doc_id._id or root_doc_id.id end
  if root_doc_id then
    local root_doc = project.get_doc_by_id(root_doc_id)
    if root_doc and root_doc.path then return root_doc.path end
  end

  local main = project.get_doc_by_path('main.tex')
  if main then return main.path end

  for _, entry in ipairs(project._project_tree) do
    if entry.type == 'doc' and entry.path:match('%.tex$') then return entry.path end
  end

  return nil
end

local function pdf_path(root_dir, main_file)
  local stem = vim.fn.fnamemodify(main_file, ':r')
  return root_dir .. '/' .. stem .. '.pdf'
end

local function open_pdf(path)
  if compile_config().open_pdf == false then return end

  local size = vim.fn.getfsize(path)
  if size <= 0 then return end

  local viewer = config.get().pdf_viewer
  if viewer then
    vim.fn.jobstart({ viewer, path }, { detach = true })
    return
  end

  local opener = vim.fn.has('mac') == 1 and 'open' or 'xdg-open'
  vim.fn.jobstart({ opener, path }, { detach = true })
end

local function flush_documents(state)
  for _, doc in pairs(state.documents or {}) do
    sync.write_doc(doc)
  end
end

function M.compile(state, callback)
  local root_dir = sync.dir()
  if not root_dir then
    callback({ message = 'Local compile requires sync_dir to be configured and active' })
    return
  end

  local main_file = find_main_file(state)
  if not main_file then
    callback({ message = 'Could not determine the main .tex file; set compile.main_file' })
    return
  end

  flush_documents(state)

  local cfg = compile_config()
  local command = cfg.local_command or { 'latexmk', '-pdf', '-interaction=nonstopmode', '-synctex=1' }
  local job_cmd = build_command(command, main_file)
  local output = {}

  config.log('debug', 'Local compile command: %s', shell_join(job_cmd))

  local job_id = vim.fn.jobstart(job_cmd, {
    cwd = root_dir,
    stdout_buffered = true,
    stderr_buffered = true,
    on_stdout = function(_, data)
      if data then vim.list_extend(output, data) end
    end,
    on_stderr = function(_, data)
      if data then vim.list_extend(output, data) end
    end,
    on_exit = function(_, code)
      local log = table.concat(output, '\n')
      if code == 0 then
        callback(nil, {
          status = 'success',
          log = log,
          pdf_path = pdf_path(root_dir, main_file),
        })
      else
        callback({
          message = string.format('Local compile failed with exit code %d', code),
          log = log,
        })
      end
    end,
  })

  if job_id <= 0 then
    callback({ message = 'Failed to start local compile command: ' .. shell_join(job_cmd) })
  end
end

function M.open_pdf(path)
  open_pdf(path)
end

function M.start_watch(state)
  if M._watch_job_id then
    config.log('info', 'Local compile watch is already running')
    return
  end

  local root_dir = sync.dir()
  if not root_dir then
    config.log('warn', 'Local compile watch requires sync_dir to be configured and active')
    return
  end

  local main_file = find_main_file(state)
  if not main_file then
    config.log('warn', 'Could not determine the main .tex file; set compile.main_file')
    return
  end

  flush_documents(state)

  local cfg = compile_config()
  local command = cfg.local_watch_command
    or { 'latexmk', '-pdf', '-pvc', '-interaction=nonstopmode', '-synctex=1' }
  local job_cmd = build_command(command, main_file)

  config.log('info', 'Starting local compile watch: %s', shell_join(job_cmd))
  local job_id = vim.fn.jobstart(job_cmd, {
    cwd = root_dir,
    on_stdout = function(_, data)
      if cfg.watch_log == true and data then
        for _, line in ipairs(data) do
          if line ~= '' then config.log('debug', '[latexmk] %s', line) end
        end
      end
    end,
    on_stderr = function(_, data)
      if cfg.watch_log == true and data then
        for _, line in ipairs(data) do
          if line ~= '' then config.log('debug', '[latexmk] %s', line) end
        end
      end
    end,
    on_exit = function(_, code)
      M._watch_job_id = nil
      if code ~= 0 then config.log('warn', 'Local compile watch exited with code %d', code) end
    end,
  })

  if job_id <= 0 then
    config.log('error', 'Failed to start local compile watch: %s', shell_join(job_cmd))
    return
  end

  M._watch_job_id = job_id

  vim.defer_fn(function() open_pdf(pdf_path(root_dir, main_file)) end, 1000)
end

function M.stop_watch(opts)
  opts = opts or {}
  if not M._watch_job_id then
    if not opts.silent then config.log('info', 'Local compile watch is not running') end
    return
  end

  vim.fn.jobstop(M._watch_job_id)
  M._watch_job_id = nil
  config.log('info', 'Stopped local compile watch')
end

function M.is_watch_running()
  return M._watch_job_id ~= nil
end

return M
