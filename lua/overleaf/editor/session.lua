local bridge = require('overleaf.bridge')
local history = require('overleaf.editor.history')
local M = {}
local Session = {}
Session.__index = Session
local owners = {}

local function present(value) return value ~= nil and value ~= vim.NIL end
local function inserting() return vim.fn.mode():match('^[iR]') ~= nil end

function Session:_status(status, detail)
  if self.on_status then
    self.on_status(status, detail)
  elseif status == 'error' then
    local recovery = #detail.recovery > 0 and ('\nRecovery files: ' .. table.concat(detail.recovery, ', ')) or ''
    vim.notify('[overleaf] ' .. tostring(detail.message) .. recovery, vim.log.levels.ERROR)
  elseif status == 'held' then
    vim.notify('[overleaf] Incoming update held; save to retry (' .. tostring(detail.reason) .. ')')
  end
end

function Session:_fail(err)
  local recovery_required = self.paused and not self.history_limit
  self.paused, self.busy = true, false
  local detail = type(err) == 'table' and vim.deepcopy(err) or { message = tostring(err) }
  detail.recovery = {}
  for capture in pairs(self.captures) do
    capture.keep = true
    detail.recovery[#detail.recovery + 1] = capture.directory
  end
  self.history_limit = not recovery_required
    and (detail.code == 'HISTORY_LIMIT' or tostring(detail.message):find('HISTORY_LIMIT:', 1, true) ~= nil)
  if self.history_limit then
    detail.reason = 'history-limit'
    self:_status('held', detail)
  else
    self:_status('error', detail)
  end
end

function Session:_capture()
  local capture = history.capture(self.buf)
  self.captures[capture] = true
  self.seen_tick = capture.changedtick
  return { capture = capture, checkpoint = history.checkpoint(capture) }
end

function Session:_schedule()
  if self.scheduled or self.stopped or self.paused then return end
  self.scheduled = true
  vim.schedule(function()
    self.scheduled = false
    if not self.stopped then self:_pump() end
  end)
end

--- Request a fresh observation, including when a remote revision arrives.
function Session:refresh()
  if self.stopped then return end
  self.dirty = true
  self:_schedule()
end

function Session:idle()
  return self.stopped or self.paused or (not self.busy and not self.scheduled and not self.dirty and #self.saves == 0)
end

function Session:_rpc(action, fields, callback, attempt)
  if self.stopped then return end
  local params = vim.tbl_extend('force', fields, {
    session = self.session,
    document = self.document,
    action = action,
    revision = self.revision,
  })
  self.request('syncDocument', params, function(err, reply)
    if self.stopped then return end
    if err then
      if err.code == 'STALE_REVISION' and (attempt or 0) < 3 then
        -- Refresh only the engine revision. The queued save remains the exact
        -- snapshot taken by BufWritePost, never the buffer's newer unsaved text.
        self:_rpc('state', {}, function() self:_rpc(action, fields, callback, (attempt or 0) + 1) end)
      else
        self:_fail(err)
      end
      return
    end
    if
      type(reply) ~= 'table'
      or reply.session ~= self.session
      or reply.document ~= self.document
      or type(reply.revision) ~= 'number'
      or reply.revision < self.revision
      or type(reply.state) ~= 'table'
    then
      self:_fail({ code = 'STALE_REPLY', message = 'Bridge reply does not match this editor session' })
      return
    end
    self.revision = reply.revision
    callback(reply)
  end)
end

function Session:_finish(reply)
  for _, entry in ipairs(self.active) do
    history.dispose(entry.capture)
    self.captures[entry.capture] = nil
  end
  self.active, self.busy = {}, false
  if reply and present(reply.state.conflict) then
    self:_status('held', { reason = 'document-conflict' })
  elseif reply and present(reply.state.held) then
    self:_status('held', reply.state.held)
  else
    self:_status('idle', {})
  end
  self:_schedule()
end

function Session:_apply(entry, reply)
  local update = reply.result
  if not present(update) or update.status ~= 'ready' then
    self:_finish(reply)
    return
  end
  if inserting() then
    self.dirty = true
    self:_finish(reply)
    return
  end
  local ok, err = pcall(function()
    -- The workspace supplies a comparison with actual disk state. Remote ACKs
    -- and the engine's desired saved branch cannot determine 'modified'.
    local modified = self.modified(update.writeContent)
    history.install(entry.capture, update.history, modified)
  end)
  if not ok then
    local message = tostring(err)
    if message:find('STALE_BUFFER:', 1, true) then
      self.dirty = true
      self:_finish(reply)
    elseif message:find('HISTORY_HELD:', 1, true) or message:find('HISTORY_LIMIT:', 1, true) then
      local reason = message:find('HISTORY_LIMIT:', 1, true) and 'history-limit' or 'undo-metadata'
      self:_rpc('hold', { token = update.token, reason = reason }, function(held) self:_finish(held) end)
    else
      self:_fail(err)
    end
    return
  end
  local captured, installed = pcall(function() return self:_capture() end)
  if not captured then
    self:_fail(installed)
    return
  end
  self.active[#self.active + 1] = installed
  self:_rpc('accept', { token = update.token, checkpoint = installed.checkpoint }, function(accepted)
    if accepted.state.buffer ~= update.content then self.dirty = true end
    self:_finish(accepted)
  end)
end

function Session:_pump()
  if self.busy or self.paused or self.stopped then return end
  if #self.saves == 0 and inserting() then return end
  local entry = table.remove(self.saves, 1)
  local action = entry and 'save' or 'checkpoint'
  if not entry then
    if not self.dirty then return end
    self.dirty = false
    local ok, captured = pcall(function() return self:_capture() end)
    if not ok then
      self:_fail(captured)
      return
    end
    entry = captured
  end
  self.busy, self.active = true, { entry }
  local fields = { checkpoint = entry.checkpoint }
  if action == 'save' then fields.bytes = vim.base64.encode(entry.saved) end
  self:_rpc(action, fields, function(reply)
    if action == 'save' then
      self:_apply(entry, reply)
    elseif #self.saves > 0 or vim.api.nvim_buf_get_changedtick(self.buf) ~= entry.capture.changedtick then
      self.dirty = true
      self:_finish(reply)
    else
      self:_rpc('prepare', {}, function(prepared) self:_apply(entry, prepared) end)
    end
  end)
end

--- Detach callbacks, preserving any unconfirmed captures for recovery. No buffer
--- is deleted and no project writer is closed by detaching one document.
function Session:stop()
  if not self.stopped then
    self.stopped = true
    vim.api.nvim_del_augroup_by_id(self.group)
    bridge.off_event('syncChanged', self.remote_event)
    if owners[self.buf] == self then owners[self.buf] = nil end
  end
  local paths = {}
  for capture in pairs(self.captures) do
    capture.keep = true
    paths[#paths + 1] = capture.directory
  end
  return paths
end

--- Bind an already opened engine document to an ordinary buffer. The workspace
--- must supply disk comparison and resolve recovered checkpoints before attach.
--- This controller is not attached by the plugin's legacy editing path.
function M.attach(buf, binding, opts)
  assert(vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == '', 'An ordinary loaded file buffer is required')
  assert(not owners[buf], 'Buffer already has an editor session')
  assert(type(opts.modified) == 'function', 'The workspace must supply a disk comparison')
  assert(type(opts.saved) == 'function', 'The workspace must supply a synchronous saved-file observation')
  assert(not binding.state.editorAttached, 'Recover or detach the existing native editor checkpoint first')
  local self = setmetatable({
    buf = buf,
    session = binding.session,
    document = binding.document,
    revision = binding.revision,
    modified = opts.modified,
    saved = opts.saved,
    request = opts.request or bridge.request,
    on_status = opts.on_status,
    captures = {},
    saves = {},
    active = {},
    dirty = true,
  }, Session)
  self.group = vim.api.nvim_create_augroup('OverleafEditor' .. buf, { clear = true })
  self.remote_event = function(event)
    if event.session == self.session and event.document == self.document then self:refresh() end
  end
  bridge.on_event('syncChanged', self.remote_event)
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'InsertLeave' }, {
    group = self.group,
    buffer = buf,
    callback = function()
      if vim.api.nvim_buf_get_changedtick(buf) ~= self.seen_tick or self.dirty then self:refresh() end
    end,
  })
  vim.api.nvim_create_autocmd('BufWritePost', {
    group = self.group,
    buffer = buf,
    callback = function()
      local ok, entry = pcall(function()
        local captured = self:_capture()
        captured.saved = self.saved()
        assert(type(captured.saved) == 'string', 'Saved-file observation must return exact bytes')
        return captured
      end)
      if not ok then
        self:_fail(entry)
        return
      end
      if self.history_limit then
        self.paused, self.history_limit = false, false
      end
      self.saves[#self.saves + 1] = entry
      self:_schedule()
    end,
  })
  vim.api.nvim_create_autocmd('OptionSet', {
    group = self.group,
    pattern = { 'endofline', 'fixendofline', 'fileformat', 'fileencoding', 'binary', 'bomb' },
    callback = function()
      if vim.api.nvim_get_current_buf() == self.buf then self:refresh() end
    end,
  })
  vim.api.nvim_create_autocmd({ 'BufUnload', 'BufWipeout' }, {
    group = self.group,
    buffer = buf,
    callback = function() self:stop() end,
  })
  owners[buf] = self
  self:_schedule()
  return self
end

return M
