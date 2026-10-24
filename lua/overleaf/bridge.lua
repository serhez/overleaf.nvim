local config = require('overleaf.config')

local M = {}

M._job_id = nil
M._request_id = 0
M._pending = {} -- id -> {callback, timer}
M._event_handlers = {} -- event_name -> handler[]
M._buffer = ''
M._started = false
M._stopping = false
M._exiting = false
M._on_unexpected_exit = nil -- callback for auto-reconnect
M._stderr_tail = {}

local function remember_stderr(line)
  table.insert(M._stderr_tail, line)
  if #M._stderr_tail > 12 then table.remove(M._stderr_tail, 1) end
end

local function exit_message()
  if #M._stderr_tail == 0 then return 'Bridge process exited' end
  return 'Bridge process exited: ' .. table.concat(M._stderr_tail, '\n')
end

function M.start(callback)
  if M._stopping or M._exiting then
    if callback then callback({ code = 'STOPPING', message = 'Bridge is draining accepted requests' }) end
    return
  end
  if M._job_id then
    if callback then callback(nil) end
    return
  end

  local script = config.bridge_script()
  local node = config.get().node_path
  M._stderr_tail = {}
  M._buffer = ''

  -- Pass base_url to bridge as OVERLEAF_URL environment variable
  local env = nil
  local base_url = config.get().base_url
  if base_url and base_url ~= 'https://www.overleaf.com' then env = { OVERLEAF_URL = base_url } end

  M._job_id = vim.fn.jobstart({ node, script }, {
    env = env,
    on_stdout = function(job, data, _)
      if job == M._job_id then M._on_stdout(data) end
    end,
    on_stderr = function(job, data, _)
      if job ~= M._job_id then return end
      for _, line in ipairs(data) do
        if line ~= '' then
          remember_stderr(line)
          config.log('debug', 'bridge: %s', line)
        end
      end
    end,
    on_exit = function(job, code, _)
      if job ~= M._job_id then return end
      config.log('warn', 'Bridge exited with code %d', code)
      local unexpected = M._started and not M._stopping
      M._job_id = nil
      M._started = false
      M._stopping = false
      -- Notify pending requests of failure
      for _, pending in pairs(M._pending) do
        if pending.timer then vim.fn.timer_stop(pending.timer) end
        if pending.callback then
          vim.schedule(function()
            if not M._exiting then pending.callback({ code = 'BRIDGE_DIED', message = exit_message() }, nil) end
          end)
        end
      end
      M._pending = {}
      -- Trigger auto-restart if bridge died unexpectedly
      if unexpected and M._on_unexpected_exit then
        vim.schedule(function()
          if not M._exiting and M._on_unexpected_exit then M._on_unexpected_exit(code) end
        end)
      end
    end,
    stdout_buffered = false,
    stderr_buffered = false,
  })

  if M._job_id <= 0 then
    config.log('error', 'Failed to start bridge process')
    M._job_id = nil
    if callback then callback({ code = 'START_FAILED', message = 'Failed to start Node.js bridge' }) end
    return
  end

  M._started = true
  config.log('info', 'Bridge started (job_id=%d)', M._job_id)

  -- Send a ping to verify bridge is ready
  M.request('ping', {}, function(err, _result)
    if callback then callback(err) end
  end)
end

function M.stop()
  if M._job_id and not M._stopping then
    M._stopping = true
    -- EOF lets Node finish accepted requests and close recovery stores. Keep
    -- the job identity until on_exit; an old exit must not clear a newer job.
    vim.fn.chanclose(M._job_id, 'stdin')
  end
end

function M.is_running() return M._job_id ~= nil and M._started end

vim.api.nvim_create_autocmd('VimLeavePre', {
  group = vim.api.nvim_create_augroup('OverleafBridgeExit', { clear = true }),
  desc = 'Drain accepted recovery writes before Neovim terminates the bridge',
  callback = function()
    local editor = package.loaded['overleaf.editor.session']
    if editor then editor.stop_all() end
    M._exiting = true
    local job = M._job_id
    if not job then return end
    M.stop()
    local reported = false
    -- Final exit cannot be cancelled here. Keep processing job IO until Node
    -- closes its stores; a deadline must not turn a slow write into an abrupt
    -- termination. The bridge separately bounds stalled network requests.
    while M._job_id == job do
      local result = vim.fn.jobwait({ job }, 1000)[1]
      if result >= 0 or result == -3 then break end
      if M._job_id == job and not reported then
        reported = true
        pcall(vim.notify, '[overleaf] Waiting for bridge shutdown before exit...', vim.log.levels.INFO)
      end
    end
  end,
})

function M.request(method, params, callback)
  if M._stopping or M._exiting then
    if callback then callback({ code = 'STOPPING', message = 'Bridge is draining accepted requests' }, nil) end
    return
  end
  if not M._job_id then
    if callback then callback({ code = 'NOT_STARTED', message = 'Bridge not started' }, nil) end
    return
  end

  M._request_id = M._request_id + 1
  local id = M._request_id

  local msg = vim.json.encode({
    id = id,
    method = method,
    params = params or {},
  })

  -- Compilation includes acknowledgement, HTTP compilation, and log download.
  -- Each phase has its own bridge deadline; allow their combined duration.
  local timeout = (method == 'syncCompile' or method == 'compile') and 90000 or 30000
  local timer = vim.fn.timer_start(timeout, function()
    local pending = M._pending[id]
    M._pending[id] = nil
    if pending and pending.callback and not M._exiting then
      vim.schedule(function()
        if not M._exiting then pending.callback({ code = 'TIMEOUT', message = method .. ' timed out' }, nil) end
      end)
    end
  end)

  M._pending[id] = { callback = callback, timer = timer }

  vim.fn.chansend(M._job_id, msg .. '\n')
end

function M.on_event(event_name, handler)
  if not M._event_handlers[event_name] then M._event_handlers[event_name] = {} end
  table.insert(M._event_handlers[event_name], handler)
end

function M.off_event(event_name, handler)
  local handlers = M._event_handlers[event_name]
  if handlers then
    for i, h in ipairs(handlers) do
      if h == handler then
        table.remove(handlers, i)
        return
      end
    end
  end
end

function M._on_stdout(data)
  -- data is a list of strings, first and last may be partial lines
  for i, chunk in ipairs(data) do
    if i == 1 then
      M._buffer = M._buffer .. chunk
    else
      -- Previous buffer forms a complete line
      local line = M._buffer
      M._buffer = chunk
      if line ~= '' then M._handle_message(line) end
    end
  end
end

function M._handle_message(line)
  local ok, msg = pcall(vim.json.decode, line)
  if not ok then
    config.log('warn', 'Failed to parse bridge message: %s', line)
    return
  end

  -- Response to a request
  if msg.id then
    local pending = M._pending[msg.id]
    M._pending[msg.id] = nil
    if pending then
      if pending.timer then vim.fn.timer_stop(pending.timer) end
      if pending.callback then
        vim.schedule(function()
          if not M._exiting then pending.callback(msg.error, msg.result) end
        end)
      end
    end
    return
  end

  -- Server-push event
  if msg.event then
    local handlers = M._event_handlers[msg.event]
    if handlers then
      vim.schedule(function()
        if M._exiting then return end
        for _, handler in ipairs(handlers) do
          handler(msg.data)
        end
      end)
    end
    return
  end
end

return M
