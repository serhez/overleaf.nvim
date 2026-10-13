local config = require('overleaf.config')
local project = require('overleaf.project')
local sync = require('overleaf.sync')
local bridge = require('overleaf.bridge')
local uv = vim.uv or vim.loop

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
      local value = tostring(part):gsub('{main}', function() return main_file end)
      if value ~= part then replaced = true end
      table.insert(result, value)
    end
    if not replaced then table.insert(result, main_file) end
    return result
  end

  command = tostring(command or '')
  if command:find('{main}', 1, true) then
    return command:gsub('{main}', function() return vim.fn.shellescape(main_file) end)
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
  local at_root = root_dir .. '/' .. vim.fn.fnamemodify(stem, ':t') .. '.pdf'
  if uv.fs_stat(at_root) then return at_root end
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

local function compile(state, callback, watch)
  local context = sync._workspace
  if not context then
    callback({ message = 'Open a project workspace before compiling' })
    return
  end

  local main_file = find_main_file(state)
  if not main_file then
    callback({ message = 'Could not determine the main .tex file; set compile.main_file' })
    return
  end

  local cfg = vim.deepcopy(compile_config())
  local function current()
    return sync._workspace == context and not context.closing and (not watch or M._watch == watch)
  end
  sync.reconcile(function(reconcile_error)
    if not current() then
      return callback({ code = 'SESSION_CLOSED', message = 'Project changed before compilation' })
    end
    if reconcile_error then return callback(reconcile_error) end
    bridge.request('syncCaptureBuild', {
      session = context.session,
      previousFingerprint = watch and watch.main == main_file and watch.fingerprint or nil,
    }, function(err, build)
      if not current() then
        return callback({ code = 'SESSION_CLOSED', message = 'Project changed during input capture' })
      end
      if err then return callback(err) end
      if build.unchanged then return callback(nil, { status = 'unchanged' }) end
      local function finish()
        bridge.request('syncFinishBuild', { session = context.session, token = build.token }, function(finish_error)
          if finish_error and current() then config.log('warn', 'Build retained: %s', finish_error.message) end
        end)
      end
      local known = false
      for _, input in ipairs(build.inputs) do
        if input.path == main_file then
          known = true
          break
        end
      end
      if not known then
        finish()
        return callback({ message = 'Main file is not a captured project source: ' .. main_file })
      end
      if watch then
        watch.fingerprint, watch.main = build.fingerprint, main_file
      end
      local command = cfg.local_command or { 'latexmk', '-pdf', '-interaction=nonstopmode', '-synctex=1' }
      local job_cmd, output = build_command(command, main_file), {}
      config.log('debug', 'Local compile command: %s', shell_join(job_cmd))
      local job_id = vim.fn.jobstart(job_cmd, {
        cwd = build.directory,
        stdout_buffered = true,
        stderr_buffered = true,
        on_stdout = function(_, data)
          if data then vim.list_extend(output, data) end
        end,
        on_stderr = function(_, data)
          if data then vim.list_extend(output, data) end
        end,
        on_exit = function(_, code)
          finish()
          if watch then
            watch.job, M._watch_job_id = nil, nil
          end
          if not current() then
            return callback({ code = 'SESSION_CLOSED', message = 'Project changed during compilation' })
          end
          local log = table.concat(output, '\n')
          if code == 0 then
            callback(nil, {
              status = 'success',
              log = log,
              pdf_path = pdf_path(build.directory, main_file),
              directory = build.directory,
              fingerprint = build.fingerprint,
            })
          else
            callback({ message = string.format('Local compile failed with exit code %d', code), log = log })
          end
        end,
      })
      if job_id <= 0 then
        finish()
        callback({ message = 'Failed to start local compile command: ' .. shell_join(job_cmd) })
      elseif watch then
        watch.job, M._watch_job_id = job_id, job_id
      end
    end)
  end)
end

function M.compile(state, callback) compile(state, callback) end

function M.open_pdf(path) open_pdf(path) end

function M.start_watch(state)
  if M._watch then
    config.log('info', 'Local compile watch is already running')
    return
  end

  local context = sync._workspace
  if not context then
    config.log('warn', 'Open a project workspace before watching saved changes')
    return
  end

  if compile_config().local_watch_command then
    config.log(
      'warn',
      'Compile watch uses saved snapshots; configure a one-shot compile.local_command instead of local_watch_command'
    )
    return
  end
  local watch = { context = context }
  M._watch = watch
  function watch.tick()
    if M._watch ~= watch or watch.busy then return end
    if sync._workspace ~= context or context.closing then return M.stop_watch({ silent = true }) end
    watch.busy = true
    compile(state, function(err, result)
      watch.busy = false
      if M._watch ~= watch then return end
      if err then
        if watch.error ~= err.message then config.log('warn', '%s', err.message) end
        watch.error = err.message
        return
      end
      watch.error = nil
      if result.status == 'unchanged' then return end
      if compile_config().watch_log then config.log('debug', '%s', result.log) end
      local destination = context.directory .. '/builds/watch-output.pdf'
      -- Compiler output stays private. Atomic publication gives PDF viewers a
      -- stable path while each compilation reads its own saved input snapshot.
      if uv.fs_stat(result.pdf_path) then
        local temporary = result.directory .. '/.watch-output.pdf'
        local copied, copy_error = uv.fs_copyfile(result.pdf_path, temporary, 1)
        local installed, install_error
        if copied then
          installed, install_error = uv.fs_rename(temporary, destination)
        end
        if not installed then
          config.log('warn', 'Cannot publish compiled PDF: %s', copy_error or install_error)
          return
        end
        result.pdf_path = destination
        if not watch.opened then
          open_pdf(destination)
          watch.opened = true
        end
      end
      watch.result = result
    end, watch)
  end
  watch.timer = vim.fn.timer_start(2000, function() watch.tick() end, { ['repeat'] = -1 })
  watch.tick()
  config.log('info', 'Watching saved project inputs for local compilation')
end

function M.stop_watch(opts)
  opts = opts or {}
  local watch = M._watch
  if not watch then
    if not opts.silent then config.log('info', 'Local compile watch is not running') end
    return
  end

  M._watch, M._watch_job_id = nil, nil
  vim.fn.timer_stop(watch.timer)
  if watch.job then vim.fn.jobstop(watch.job) end
  config.log('info', 'Stopped local compile watch')
end

function M.is_watch_running() return M._watch ~= nil end

return M
