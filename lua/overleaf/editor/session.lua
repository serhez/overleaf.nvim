local bridge = require('overleaf.bridge')
local history = require('overleaf.editor.history')
local M = {}
local Session = {}
Session.__index = Session
local owners = {}
local uv = vim.uv or vim.loop

local function present(value) return value ~= nil and value ~= vim.NIL end
-- Keep an active selection and insert/replace undo group stable. Incoming
-- revisions remain durable and are installed when the interaction ends.
local function interacting() return vim.fn.mode():match('^[iRvVsS\22\19]') ~= nil end

-- Compare ordinary full-write bytes, including options which undo does not
-- restore. Unsupported representations must never be declared saved.
local function matches_disk(buf, bytes, for_read)
  local opts = vim.bo[buf]
  if
    opts.binary
    or (opts.fileencoding ~= '' and opts.fileencoding ~= 'utf-8')
    or (opts.fileformat ~= 'unix' and opts.fileformat ~= 'dos')
    or vim.api.nvim_buf_get_offset(buf, vim.api.nvim_buf_line_count(buf)) > 16 * 1024 * 1024
  then
    return false
  end
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  for _, line in ipairs(lines) do
    if line:find('\n', 1, true) or line:find('\0', 1, true) then return false end
  end
  local separator = opts.fileformat == 'dos' and '\r\n' or '\n'
  local content = table.concat(lines, separator)
  local empty = vim.api.nvim_buf_call(buf, function() return vim.fn.wordcount().chars == 0 end)
  if not empty and (opts.endofline or (not for_read and opts.fixendofline)) then content = content .. separator end
  if opts.bomb then content = '\239\187\191' .. content end
  return content == bytes
end

--- Compare the buffer's read representation, without adding fixendofline bytes.
function M.matches_read(buf, bytes) return matches_disk(buf, bytes, true) end

local function workspace_reader(buf, workspace)
  local filename = workspace.root .. '/' .. workspace.path
  local root = assert(uv.fs_lstat(workspace.root))
  local function guard()
    assert(uv.fs_realpath(vim.api.nvim_buf_get_name(buf)) == filename, 'STALE_BUFFER: Workspace buffer was renamed')
    local parents, directory = {}, workspace.root
    local parts = vim.split(workspace.path, '/', { plain = true })
    for i = 0, #parts - 1 do
      if i > 0 then directory = directory .. '/' .. parts[i] end
      local stat = assert(uv.fs_lstat(directory))
      assert(stat.type == 'directory', 'UNSAFE_PATH: Source parent is not a directory')
      parents[#parents + 1] = { stat.dev, stat.ino }
    end
    assert(parents[1][1] == root.dev and parents[1][2] == root.ino, 'UNSAFE_PATH: Workspace root changed')
    return parents
  end
  local function metadata(stat)
    local result = {}
    for _, name in ipairs({ 'dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtime', 'ctime' }) do
      result[name] = stat[name]
    end
    return result
  end
  local function read()
    local parents = guard()
    local before = assert(uv.fs_lstat(filename))
    assert(before.type == 'file' and before.nlink == 1, 'UNSAFE_PATH: Source must be a regular file with one link')
    assert(before.size <= 16 * 1024 * 1024, 'FILE_LIMIT: Source exceeds the 16 MiB observation limit')
    -- Luv does not expose every open flag on supported Neovim builds. The
    -- local Node bridge supplies this host's no-follow/nonblocking read flags.
    local fd = assert(uv.fs_open(filename, workspace.readFlags, 0))
    local ok, value = pcall(function()
      assert(
        vim.deep_equal(metadata(before), metadata(assert(uv.fs_fstat(fd)))),
        'UNSTABLE_FILE: Source changed while opening'
      )
      local bytes = assert(uv.fs_read(fd, before.size + 1, 0))
      assert(#bytes == before.size, 'UNSTABLE_FILE: Source size changed')
      assert(
        vim.deep_equal(metadata(before), metadata(assert(uv.fs_fstat(fd)))),
        'UNSTABLE_FILE: Source changed while reading'
      )
      assert(
        vim.deep_equal(metadata(before), metadata(assert(uv.fs_lstat(filename)))),
        'UNSTABLE_FILE: Source was replaced'
      )
      assert(vim.deep_equal(parents, guard()), 'UNSTABLE_FILE: Source parent changed')
      return { bytes = bytes, metadata = metadata(before), parents = parents }
    end)
    assert(uv.fs_close(fd))
    if not ok then error(value, 0) end
    return value
  end
  return function()
    local first, second = read(), read()
    assert(vim.deep_equal(first, second), 'UNSTABLE_FILE: Source has not settled')
    return second.bytes
  end,
    guard
end

function Session:_status(status, detail)
  if self.on_status then
    self.on_status(status, detail)
    return
  end
  local notice = status .. ':' .. tostring(detail.reason) .. ':' .. tostring(detail.message)
  if self.last_notice == notice then return end
  self.last_notice = notice
  if status == 'error' then
    local recovery = #detail.recovery > 0 and ('\nRecovery files: ' .. table.concat(detail.recovery, ', ')) or ''
    vim.notify('[overleaf] ' .. tostring(detail.message) .. recovery, vim.log.levels.ERROR)
  elseif status == 'held' then
    local reason = tostring(detail.reason)
    local command = reason == 'history-conflict' and ':Overleaf resolve history'
      or reason == 'persistent-undo' and ':Overleaf resolve disk-history'
      or (reason == 'write-recovery' or reason == 'workspace-recovery' or reason == 'history-limit') and ':Overleaf recover'
      or ':Overleaf resolve'
    vim.notify(
      '[overleaf] Update retained ('
        .. reason
        .. '); review with '
        .. command
        .. (detail.message and ('\n' .. detail.message) or '')
    )
  end
end

function Session:_fail(err)
  local recovery_required = self.paused and not self.history_limit
  self.paused, self.busy = true, false
  local detail = type(err) == 'table' and vim.deepcopy(err) or { message = tostring(err) }
  self.last_error = detail
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
  if self.check_path then self.check_path() end
  local capture =
    history.capture(self.buf, { directory = self.capture_directory, document = self.document, session = self.session })
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
  return self.stopped
    or self.paused
    or (not self.busy and not self.saving and not self.scheduled and not self.dirty and #self.saves == 0)
end

function Session:_receive(reply)
  assert(
    type(reply) == 'table'
      and reply.session == self.session
      and reply.document == self.document
      and type(reply.revision) == 'number'
      and reply.revision >= self.revision
      and type(reply.state) == 'table',
    { code = 'STALE_REPLY', message = 'Bridge reply does not match this editor session' }
  )
  assert(
    not self.source_path or (present(reply.workspace) and reply.workspace.path == self.source_path),
    { code = 'PATH_BOUND', message = 'Source path changed; review the rename before continuing' }
  )
  self.revision = reply.revision
  self.state = reply.state
  if self.workspace and present(reply.state.disk) then self.disk_content = reply.state.disk.content end
end

-- Saves must finish locally before :w or :wq returns. A timeout does not cancel
-- the writer: ignore late replies and keep the frozen capture for recovery.
function Session:_wait_request(action, fields, before_receive)
  local done, expired, failure, result = false, false, nil, nil
  self.request(
    'syncDocument',
    vim.tbl_extend('force', fields, {
      session = self.session,
      document = self.document,
      action = action,
      revision = self.revision,
      sourcePath = action ~= 'state' and self.source_path or nil,
    }),
    function(err, reply)
      if expired then return end
      failure, result, done = err, reply, true
    end
  )
  if not vim.wait(30000, function() return done or self.stopped end, 10) or not done then
    expired = true
    error({ code = 'WRITE_UNCERTAIN', message = 'Save completion is unknown; inspect recovery before retrying' }, 0)
  end
  if failure then error(failure, 0) end
  if before_receive then before_receive(result) end
  self:_receive(result)
  return result
end

local function check_write_options(buf) assert(not vim.bo[buf].readonly, 'READ_ONLY: Source buffer is read-only') end

local function save_options(buf)
  return {
    enabled = vim.bo[buf].undofile,
    directory = vim.o.undodir,
    backup = vim.o.backup,
    backupdir = vim.o.backupdir,
    backupext = vim.o.backupext,
    backupskip = vim.o.backupskip,
    patchmode = vim.o.patchmode,
  }
end

local function undo_artifact(entry, advance)
  if not entry.save_options.enabled then return vim.NIL end
  local filename = vim.fn.undofile(vim.api.nvim_buf_get_name(entry.capture.bufnr))
  if filename == '' then return vim.NIL end
  local parent = assert(uv.fs_realpath(vim.fn.fnamemodify(filename, ':h')), 'UNDO_PATH: Undo directory is unavailable')
  local artifact = history.saved_artifact(entry.capture, advance)
  artifact.path = parent .. '/' .. vim.fn.fnamemodify(filename, ':t')
  return artifact
end

local function option_parts(value)
  local parts, current, index = {}, '', 1
  while index <= #value do
    local char, next_char = value:sub(index, index), value:sub(index + 1, index + 1)
    if char == '\\' and (next_char == ',' or next_char == '\\' or next_char == ' ') then
      current, index = current .. next_char, index + 2
    elseif char == ',' then
      parts[#parts + 1], current, index = current, '', index + 1
      while value:sub(index, index) == ' ' do
        index = index + 1
      end
    else
      current, index = current .. char, index + 1
    end
  end
  if current ~= '' then parts[#parts + 1] = current end
  return parts
end

local function backup_artifacts(entry)
  local opts, result = entry.save_options, {}
  if not opts.backup and opts.patchmode == '' then return nil end
  local filename = vim.api.nvim_buf_get_name(entry.capture.bufnr)
  for _, pattern in ipairs(option_parts(opts.backupskip)) do
    local regex = vim.fn.glob2regpat(pattern)
    if vim.fn.match(filename, regex) >= 0 or vim.fn.match(vim.fn.fnamemodify(filename, ':t'), regex) >= 0 then
      return nil
    end
  end
  local directories = option_parts(opts.backupdir)
  assert(#directories > 0, 'BACKUP_PATH: Backup directory is empty')
  local selected, full_path
  for index, directory in ipairs(directories) do
    local munged = directory:sub(-2) == '//'
    if directory == '.' or directory:sub(1, 2) == './' then
      directory = vim.fn.fnamemodify(filename, ':h') .. directory:sub(2)
    end
    directory = vim.fn.expand(directory)
    if vim.fn.isdirectory(directory) == 0 and index == #directories then vim.fn.mkdir(directory, 'p', 448) end
    if vim.fn.isdirectory(directory) == 1 and uv.fs_access(directory, 'W') then
      selected, full_path = assert(uv.fs_realpath(directory)), munged
      break
    end
  end
  assert(selected, 'BACKUP_PATH: No writable backup directory')
  if opts.backup then
    local name = full_path and filename:gsub('/', '%%') or vim.fn.fnamemodify(filename, ':t')
    result[#result + 1] = { path = selected .. '/' .. name .. opts.backupext, once = false }
  end
  if opts.patchmode ~= '' then result[#result + 1] = { path = filename .. opts.patchmode, once = true } end
  return result
end

local function matches_write_handler(autocmd, buf)
  if autocmd.buffer then return autocmd.buffer == buf end
  local filename = vim.api.nvim_buf_get_name(buf)
  local pattern = vim.fn.glob2regpat(autocmd.pattern)
  return vim.fn.match(filename, pattern) >= 0 or vim.fn.match(vim.fn.fnamemodify(filename, ':t'), pattern) >= 0
end

function Session:_check_write_handler()
  -- Never issue the nested command unless our handler will intercept it.
  -- No yielding or user hooks occur between this check and the command.
  local found = false
  for _, autocmd in ipairs(vim.api.nvim_get_autocmds({ event = 'BufWriteCmd' })) do
    if matches_write_handler(autocmd, self.buf) then
      assert(autocmd.id == self.write_autocmd, 'SAVE_FINALIZATION: Another write handler owns the buffer')
      found = true
    end
  end
  assert(found, 'SAVE_FINALIZATION: Guarded write handler was removed')
  local ignored = vim.o.eventignore
  if vim.fn.exists('+eventignorewin') == 1 then ignored = ignored .. ',' .. vim.wo.eventignorewin end
  for event in ignored:gmatch('[^,]+') do
    assert(event ~= 'all' and event ~= 'BufWriteCmd', 'SAVE_FINALIZATION: Write events are disabled')
  end
end

function Session:_finalize_save(entry, content)
  local ok, err = pcall(function()
    self:_check_write_handler()
    local before = vim.api.nvim_buf_call(self.buf, vim.fn.undotree)
    local completion = { entry = entry, content = content, consumed = false }
    self.finalizing = completion
    vim.api.nvim_buf_call(self.buf, function() vim.cmd('silent keepalt keepjumps write') end)
    assert(completion.consumed, 'SAVE_FINALIZATION: Native completion was not intercepted')
    local after = vim.api.nvim_buf_call(self.buf, vim.fn.undotree)
    assert(
      after.save_last == before.save_last + 1 and after.save_cur == after.save_last,
      'SAVE_FINALIZATION: Native save marker was not finalized exactly once'
    )
  end)
  self.finalizing = nil
  if not ok then
    vim.bo[self.buf].modified = true
    error(err, 0)
  end
end

function Session:_write(event)
  if self.adopting_path then
    assert(
      self.busy and not self.adopting_path.consumed and event.buf == self.buf,
      'STALE_RELOCATION: Unexpected path adoption'
    )
    self.check_path()
    self.adopting_path.consumed = true
    return
  end
  if self.finalizing then
    local completion = self.finalizing
    assert(
      self.saving and not completion.consumed and event.buf == self.buf,
      'SAVE_FINALIZATION: Unexpected recursive save'
    )
    self.check_path()
    assert(
      uv.fs_realpath(event.file) == uv.fs_realpath(vim.api.nvim_buf_get_name(self.buf)),
      'SAVE_FINALIZATION: Completion target changed'
    )
    history.checkpoint(completion.entry.capture)
    assert(self.saved() == completion.content, 'SAVE_FINALIZATION: Source changed before completion')
    completion.consumed = true
    vim.bo[self.buf].modified = false
    return
  end
  local initially_modified = vim.bo[self.buf].modified
  assert(not self.saving, 'SAVE_BUSY: A local save is already in progress')
  assert(not self.paused and not self.stopped, 'SAVE_HELD: Resolve the editor hold before saving')
  self.check_path()
  assert(
    uv.fs_realpath(event.file) == uv.fs_realpath(vim.api.nvim_buf_get_name(self.buf)),
    'UNSUPPORTED_WRITE: Save only to the bound source file'
  )
  assert(vim.v.cmdarg == '', 'UNSUPPORTED_WRITE: Write option overrides are not supported')
  check_write_options(self.buf)
  self.saving = true
  local entry
  local finalized = false
  local function record_save()
    if finalized or not (initially_modified or entry.capture.modified) then return end
    local current = self:_capture()
    history.record_save(current.capture, entry.capture)
    history.dispose(current.capture)
    self.captures[current.capture] = nil
    finalized = true
  end
  local ok, err = pcall(function()
    assert(
      vim.wait(30000, function() return not self.busy or self.paused or self.stopped end, 10),
      'SAVE_BUSY: Previous editor request has not completed'
    )
    assert(not self.paused and not self.stopped, 'SAVE_HELD: Editor request failed before saving')
    vim.api.nvim_exec_autocmds('BufWritePre', { buffer = self.buf, modeline = false })
    check_write_options(self.buf)
    local disk = self.saved()
    if disk ~= self.disk_content then
      error(
        { code = 'DISK_CHANGED', message = 'External text needs reconciliation before saving; retry after the update' },
        0
      )
    end
    entry = self:_capture()
    entry.save_options = save_options(self.buf)
    local fields = {
      checkpoint = entry.checkpoint,
      expected = disk,
      undo = undo_artifact(entry, initially_modified or entry.capture.modified),
      backups = backup_artifacts(entry),
    }
    local reply
    for attempt = 1, 3 do
      local success, value = pcall(self._wait_request, self, 'write', fields)
      if success then
        reply = value
        break
      end
      if type(value) ~= 'table' or value.code ~= 'STALE_REVISION' or attempt == 3 then error(value, 0) end
      self:_wait_request('state', {})
    end
    assert(present(reply.result) and reply.result.status == 'written', 'WRITE_UNCERTAIN: Missing save receipt')
    -- Callbacks may run while waiting. Never clear newer edits or allow :wq to
    -- quit on the strength of an older, successfully written snapshot.
    local written_options = entry.checkpoint.options
    local unchanged = pcall(history.checkpoint, entry.capture)
    local still_saved = self.saved() == reply.result.content
    if not unchanged or not still_saved or not vim.deep_equal(entry.save_options, save_options(self.buf)) then
      vim.bo[self.buf].modified = true
      record_save()
      error({
        code = 'SAVE_CHANGED',
        message = 'Captured text was saved, but the buffer or file changed; newer edits remain unsaved',
      }, 0)
    end
    if not initially_modified and vim.bo[self.buf].modified then
      -- The outer native command captured a clean initial state. An intercepted
      -- inner command lets Neovim finalize undo flags once after formatting.
      self:_finalize_save(entry, reply.result.content)
      finalized = true
    else
      vim.bo[self.buf].modified = false
    end
    local tick = vim.api.nvim_buf_get_changedtick(self.buf)
    local post_ok, post_error =
      pcall(vim.api.nvim_exec_autocmds, 'BufWritePost', { buffer = self.buf, modeline = false })
    local options_unchanged = vim.deep_equal(entry.save_options, save_options(self.buf))
    for name, value in pairs(written_options) do
      if vim.bo[self.buf][name] ~= value then options_unchanged = false end
    end
    if vim.api.nvim_buf_get_changedtick(self.buf) ~= tick or not options_unchanged then
      vim.bo[self.buf].modified = true
      record_save()
      error({ code = 'SAVE_CHANGED', message = 'Captured text was saved; post-write edits remain unsaved' }, 0)
    end
    if not post_ok then error(post_error, 0) end
    history.dispose(entry.capture)
    self.captures[entry.capture] = nil
    entry = nil
  end)
  self.saving = false
  self.dirty = true
  if not ok then
    local code = type(err) == 'table' and err.code or nil
    if code == 'DISK_CHANGED' or code == 'STALE_REVISION' or code == 'SAVE_CHANGED' or code == 'READ_ONLY' then
      if entry then
        history.dispose(entry.capture)
        self.captures[entry.capture] = nil
      end
    else
      self:_fail(err)
    end
    self:_schedule()
    error(type(err) == 'table' and (err.code .. ': ' .. err.message) or err, 0)
  end
  self:_schedule()
end

function Session:_rpc(action, fields, callback, attempt)
  if self.stopped then return end
  local params = vim.tbl_extend('force', fields, {
    session = self.session,
    document = self.document,
    action = action,
    revision = self.revision,
    sourcePath = self.source_path,
  })
  self.request('syncDocument', params, function(err, reply)
    if self.stopped then return end
    if err then
      if err.code == 'STALE_REVISION' and (attempt or 0) < 3 then
        -- Refresh only the engine revision. The queued save remains the exact
        -- snapshot taken by BufWritePost, never the buffer's newer unsaved text.
        self:_rpc('state', {}, function() self:_rpc(action, fields, callback, (attempt or 0) + 1) end)
      elseif err.code == 'STALE_DISK_WRITE' and (action == 'writeDiskUndo' or action == 'holdDiskUndo') then
        self.dirty = true
        self:_finish()
      else
        self:_fail(err)
      end
      return
    end
    local accepted, failure = pcall(self._receive, self, reply)
    if not accepted then
      self:_fail(failure)
      return
    end
    callback(reply)
  end)
end

function Session:_finish(reply)
  for _, entry in ipairs(self.active) do
    history.dispose(entry.capture)
    self.captures[entry.capture] = nil
  end
  self.active, self.busy = {}, false
  if reply and present(reply.result) and reply.result.status == 'held' then
    self:_status('held', reply.result)
  elseif reply and present(reply.state.conflict) then
    self:_status('held', { reason = 'document-conflict' })
  elseif reply and present(reply.state.held) then
    self:_status('held', reply.state.held)
  elseif reply and present(reply.state.disk) and present(reply.state.disk.held) then
    self:_status('held', reply.state.disk.held)
  else
    self:_status('idle', {})
  end
  if self.on_change then self.on_change(self) end
  self:_schedule()
end

function Session:_apply(entry, reply)
  local update = reply.result
  if present(update) and update.status == 'undo-required' then
    if interacting() or self.saving or self.paused then
      self.dirty = true
      self:_finish(reply)
      return
    end
    local ok, prepared = pcall(history.rebase_saved, update.checkpoint, update.bytes, update.history)
    if not ok then
      local message = tostring(prepared)
      if message:find('HISTORY_HELD:', 1, true) or message:find('HISTORY_LIMIT:', 1, true) then
        local reason = message:find('HISTORY_LIMIT:', 1, true) and 'history-limit' or 'undo-metadata'
        self:_rpc('holdDiskUndo', { token = update.token, reason = reason }, function(held) self:_finish(held) end)
      else
        self:_fail(prepared)
      end
      return
    end
    self:_rpc('writeDiskUndo', {
      token = update.token,
      checkpoint = prepared.checkpoint,
      bytes = prepared.bytes,
    }, function(written)
      self.dirty = true
      self:_finish(written)
    end)
    return
  end
  if not present(update) or update.status ~= 'ready' then
    self:_finish(reply)
    return
  end
  if interacting() or self.saving or self.paused then
    self.dirty = true
    self:_finish(reply)
    return
  end
  local ok, err = pcall(function()
    -- The workspace supplies a comparison with actual disk state. Remote ACKs
    -- and the engine's desired saved branch cannot determine 'modified'.
    local modified
    if self.workspace then
      local disk = self.saved()
      assert(disk == reply.state.disk.content, 'STALE_DISK: Source changed before the buffer update')
      modified = disk ~= update.writeContent
    else
      modified = self.modified(update.writeContent)
    end
    history.install(entry.capture, update.history, modified)
  end)
  if not ok then
    local message = tostring(err)
    if message:find('STALE_BUFFER:', 1, true) or message:find('STALE_DISK:', 1, true) then
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
  if self.busy or self.saving or self.paused or self.stopped then return end
  if #self.saves == 0 and interacting() then return end
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
    if action == 'save' and self.workspace then
      self.dirty = true
      self:_finish(reply)
    elseif action == 'save' then
      self:_apply(entry, reply)
    elseif #self.saves > 0 or vim.api.nvim_buf_get_changedtick(self.buf) ~= entry.capture.changedtick then
      self.dirty = true
      self:_finish(reply)
    else
      self:_rpc('prepare', {}, function(prepared) self:_apply(entry, prepared) end)
    end
  end)
end

--- An explicit text recovery creates one ordinary local undo unit. Original
--- captures and the current native undo tree remain available; disk is untouched.
function Session:restore_capture(review, selected)
  assert(not self.stopped and not self.saving and not self.busy, 'RECOVERY_BUSY: Editor is busy')
  assert(vim.tbl_contains(review.captures, selected), 'INVALID_CAPTURE: Select a reviewed capture')
  local state = self:_wait_request('state', {})
  assert(
    state.revision == review.revision and vim.api.nvim_buf_get_changedtick(self.buf) == review.tick,
    'STALE_BUFFER: Source changed after the recovery review'
  )
  assert(
    type(selected.content) == 'string'
      and #selected.content <= 16 * 1024 * 1024
      and not selected.content:find('\0', 1, true),
    'INVALID_CAPTURE: Unsupported captured text'
  )
  local before = self:_capture()
  before.capture.keep = true
  vim.bo[self.buf].undolevels = vim.bo[self.buf].undolevels
  vim.api.nvim_buf_set_lines(
    self.buf,
    0,
    -1,
    false,
    selected.empty and {} or vim.split(selected.content, '\n', { plain = true })
  )
  vim.bo[self.buf].undolevels = vim.bo[self.buf].undolevels
  self:refresh()
end

--- Freeze an inspection for explicit recovery. Read-only requests may not race
--- the controller's ordinary revision handling; retry if remote state advances
--- between the two observations. Retained capture files are never deleted here.
function Session:inspect()
  assert(self.workspace and not self.stopped and not self.saving, 'RECOVERY_BUSY: Cannot inspect this editor now')
  assert(vim.wait(30000, function() return not self.busy end, 10), 'RECOVERY_BUSY: Editor request is pending')
  local tick = vim.api.nvim_buf_get_changedtick(self.buf)
  for _ = 1, 3 do
    local snapshot = self:_wait_request('snapshot', {})
    local disk = self:_wait_request('diskState', {})
    if snapshot.revision == disk.revision then
      local captures = {}
      for capture in pairs(self.captures) do
        captures[#captures + 1] = { path = capture.directory, content = capture.content, empty = capture.empty }
      end
      local retained = self:_wait_request('captures', {})
      local seen = {}
      for _, capture in ipairs(captures) do
        seen[capture.path] = true
      end
      for _, capture in ipairs(retained.result) do
        if not seen[capture.path] then captures[#captures + 1] = capture end
      end
      assert(vim.api.nvim_buf_get_changedtick(self.buf) == tick, 'STALE_BUFFER: Source changed during review')
      return {
        revision = disk.revision,
        tick = tick,
        state = snapshot.result,
        disk = disk.result,
        captures = captures,
        buffer = table.concat(vim.api.nvim_buf_get_lines(self.buf, 0, -1, false), '\n'),
        held = self.paused and self.last_error or nil,
      }
    end
  end
  error('STALE_REVISION: Document changed during recovery inspection', 0)
end

function Session:review_relocation()
  assert(self.workspace and not self.stopped and not self.saving, 'RECOVERY_BUSY: Cannot review this source now')
  assert(vim.wait(30000, function() return not self.busy end, 10), 'RECOVERY_BUSY: Editor request is pending')
  return self:_wait_request('reviewRelocation', {}).result
end

function Session:review_lifecycle()
  assert(self.workspace and not self.stopped and not self.saving, 'RECOVERY_BUSY: Cannot review this source now')
  assert(vim.wait(30000, function() return not self.busy end, 10), 'RECOVERY_BUSY: Editor request is pending')
  return self:_wait_request('reviewLifecycle', {}).result
end

function Session:keep_local(review, uncertain)
  assert(not self.stopped and not self.saving and not self.busy, 'RECOVERY_BUSY: Editor is busy')
  self.busy = true
  local entry
  local ok, result = pcall(function()
    entry = self:_capture()
    return self:_wait_request(uncertain and 'keepUncertainLocal' or 'keepLocal', {
      review = review,
      checkpoint = entry.checkpoint,
    })
  end)
  if not ok then
    local inspected, current = pcall(self._wait_request, self, 'state', {})
    if inspected and current.state.publication == 'local-only' then
      ok, result = true, current
    end
  end
  self.busy = false
  if not ok then
    self:_fail(result)
    error(result, 0)
  end
  history.dispose(entry.capture)
  self.captures[entry.capture] = nil
  self.paused = false
  self:refresh()
  return result
end

function Session:import_branch(source)
  assert(not self.stopped and not self.paused and not self.saving, 'MIGRATION_HELD: Resolve this editor first')
  assert(vim.wait(30000, function() return not self.busy end, 10), 'RECOVERY_BUSY: Editor request is pending')
  self.busy = true
  local entry
  local ok, result = pcall(function()
    entry = self:_capture()
    return self:_wait_request('importBranch', { source = source, checkpoint = entry.checkpoint })
  end)
  self.busy = false
  if not ok then
    self:_fail(result)
    error(result, 0)
  end
  history.dispose(entry.capture)
  self.captures[entry.capture] = nil
  self:refresh()
  return result
end

--- Change only the source name and disk reader. Native text and undo remain in
--- the same buffer, including edits made while the bridge request was pending.
function Session:relocate(review, local_only)
  assert(not self.stopped and not self.saving and not self.busy, 'RECOVERY_BUSY: Editor is busy')
  local filename = review.workspace and self.source_root .. '/' .. review.workspace.to
  assert(filename and review.workspace.from == self.source_path, 'STALE_RELOCATION: Review the current source')
  local function check_target()
    local target = vim.fn.bufnr(filename)
    assert(target < 0 or target == self.buf, 'TARGET_BUFFER: A different buffer owns the new path')
  end
  check_target()
  self.busy = true
  local entry
  local function adopt(reply)
    check_target()
    assert(
      reply.workspace.root == self.source_root and reply.workspace.path == review.workspace.to,
      'STALE_RELOCATION: Unexpected source path'
    )
    assert(not local_only or reply.state.publication == 'local-only', 'STALE_RELOCATION: Source is still synchronized')
    vim.api.nvim_buf_call(self.buf, function() vim.cmd('silent noautocmd file ' .. vim.fn.fnameescape(filename)) end)
    self.saved, self.check_path = workspace_reader(self.buf, reply.workspace)
    self.check_path()
    self.source_path = reply.workspace.path
    -- :file sets Neovim's "not edited" flag. Let the verified owned handler
    -- acknowledge the copied source without writing text or adding a save
    -- marker, so the next ordinary :write works without a force modifier.
    self:_check_write_handler()
    local tree = vim.api.nvim_buf_call(self.buf, vim.fn.undotree)
    local adoption = { consumed = false }
    self.adopting_path = adoption
    local acknowledged, failure = pcall(
      vim.api.nvim_buf_call,
      self.buf,
      function() vim.cmd('silent keepalt keepjumps lockmarks write!') end
    )
    self.adopting_path = nil
    assert(acknowledged and adoption.consumed, failure or 'STALE_RELOCATION: Path adoption was not intercepted')
    assert(
      vim.deep_equal(tree, vim.api.nvim_buf_call(self.buf, vim.fn.undotree)),
      'STALE_RELOCATION: Native history changed'
    )
  end
  local ok, result = pcall(function()
    if local_only then entry = self:_capture() end
    return self:_wait_request(local_only and 'archiveLocal' or 'relocate', {
      review = review,
      checkpoint = entry and entry.checkpoint or nil,
    }, adopt)
  end)
  if not ok then
    -- A lost reply cannot authorize another copy. Read the serialized engine
    -- state and adopt only this same document's already committed target path.
    local recovered, receipt = pcall(self._wait_request, self, 'state', {}, adopt)
    if recovered then
      ok, result = true, receipt
    end
  end
  self.busy = false
  if not ok then
    self:_fail(result)
    error(result, 0)
  end
  if entry then
    history.dispose(entry.capture)
    self.captures[entry.capture] = nil
  end
  self.paused = false
  self:refresh()
  return result
end

--- Freeze the native tree and incoming target for explicit historical choices.
--- The review capture is retained until resolved or the controller is detached.
function Session:_review_resolution(kind)
  assert(not self.stopped and not self.saving and not self.paused, 'RECOVERY_BUSY: Cannot review history now')
  assert(vim.wait(30000, function() return self:idle() end, 10), 'RECOVERY_BUSY: Editor request is pending')
  self.busy = true
  local entry
  local ok, result = pcall(function()
    entry = self:_capture()
    self:_wait_request('checkpoint', { checkpoint = entry.checkpoint })
    local prepared = self:_wait_request('prepare', {})
    local snapshot = self:_wait_request('snapshot', {})
    local state = snapshot.result
    local draft, choices, conflict, id, workspace_revision
    if kind == 'disk' then
      assert(self.workspace, 'NO_WORKSPACE: Saved history requires a workspace')
      local disk = self:_wait_request('diskState', {})
      assert(disk.revision == snapshot.revision, 'STALE_REVISION: Document changed during history review')
      workspace_revision = disk.result.record.revision
      conflict = self:_wait_request('prepareDiskUndoResolution', {
        workspaceRevision = workspace_revision,
        resolutions = vim.empty_dict(),
      }).result
      assert(conflict.status == 'conflict', 'NO_HISTORY_CONFLICT: No saved history conflict needs a choice')
      draft = state.disk.historyReview
      choices = present(draft)
          and draft.content == state.saved
          and draft.workspaceRevision == workspace_revision
          and draft.resolutions
        or {}
    elseif kind == 'document' then
      assert(present(state.conflict), 'NO_CONFLICT: No document conflict is held')
      id = state.conflict.id
      conflict =
        self:_wait_request('prepareConflictResolution', { conflict = id, resolutions = vim.empty_dict() }).result
      draft = state.editor.conflictReview
      choices = present(draft)
          and draft.id == id
          and draft.remoteVersion == state.remote.version
          and draft.saved == state.saved
          and draft.disk == (present(state.disk) and state.disk.content or vim.NIL)
          and draft.choices
        or {}
    else
      assert(
        present(prepared.state.held) and prepared.state.held.reason == 'history-conflict',
        'NO_HISTORY_CONFLICT: No native history conflict is held'
      )
      conflict = prepared.state.held
      draft = state.editor.historyReview
      choices = present(draft) and draft.content == state.buffer and draft.resolutions or {}
    end
    return {
      revision = self.revision,
      entry = entry,
      kind = kind,
      id = id,
      workspace_revision = workspace_revision,
      conflict = conflict,
      resolutions = choices,
    }
  end)
  self.busy = false
  if not ok then
    if entry then
      history.dispose(entry.capture)
      self.captures[entry.capture] = nil
    end
    self.dirty = true
    self:_schedule()
    error(result, 0)
  end
  return result
end

function Session:review_history() return self:_review_resolution('history') end

function Session:review_conflict() return self:_review_resolution('document') end

function Session:review_disk_history() return self:_review_resolution('disk') end

--- Apply reviewed choices only after every native state can be reconstructed.
--- Neither opening the review nor resolving one of several states changes text.
function Session:_resolve_review(review, resolutions, preview)
  assert(not self.stopped and not self.saving and not self.busy and not self.paused, 'RECOVERY_BUSY: Editor is busy')
  assert(review.revision == self.revision, 'STALE_REVISION: Review history again before accepting')
  history.checkpoint(review.entry.capture) -- Includes changedtick, options, and native tree guards.
  self.busy = true
  local installing = false
  local ok, result = pcall(function()
    local action = review.kind == 'document' and 'prepareConflictResolution'
      or review.kind == 'disk' and 'prepareDiskUndoResolution'
      or 'prepareHistoryResolution'
    local reply = self:_wait_request(action, {
      conflict = review.id,
      workspaceRevision = review.workspace_revision,
      resolutions = next(resolutions) and resolutions or vim.empty_dict(),
    })
    review.revision = self.revision
    local proposal = reply.result
    if proposal.status == 'undo-required' and review.kind == 'disk' then
      if preview then return { status = 'ready', content = proposal.content } end
      local artifact = history.rebase_saved(proposal.checkpoint, proposal.bytes, proposal.history)
      installing = true
      local written = self:_wait_request('writeDiskUndo', {
        token = proposal.token,
        checkpoint = artifact.checkpoint,
        bytes = artifact.bytes,
      })
      self.active, self.dirty = { review.entry }, true
      self:_finish(written)
      return { status = 'accepted' }
    end
    if proposal.status ~= 'ready' or preview then return proposal end
    local modified
    if self.workspace then
      local disk = self.saved()
      assert(disk == reply.state.disk.content, 'STALE_DISK: Source changed during history review')
      modified = disk ~= proposal.writeContent
    else
      modified = self.modified(proposal.writeContent)
    end
    installing = true
    history.install(review.entry.capture, proposal.history, modified)
    local installed = self:_capture()
    self.active = { review.entry, installed }
    local accepted = self:_wait_request('accept', { token = proposal.token, checkpoint = installed.checkpoint })
    self.dirty = true
    self:_finish(accepted)
    return { status = 'accepted' }
  end)
  self.busy = false
  if not ok then
    if installing then self:_fail(result) end
    self:_schedule()
    error(result, 0)
  end
  self:_schedule()
  return result
end

function Session:resolve_history(review, resolutions, preview)
  assert(review.kind == 'history', 'Wrong resolution review')
  return self:_resolve_review(review, resolutions, preview)
end

function Session:resolve_conflict(review, resolutions, preview)
  assert(review.kind == 'document', 'Wrong resolution review')
  return self:_resolve_review(review, resolutions, preview)
end

function Session:resolve_disk_history(review, resolutions, preview)
  assert(review.kind == 'disk', 'Wrong resolution review')
  return self:_resolve_review(review, resolutions, preview)
end

function Session:close_history(review)
  if self.captures[review.entry.capture] and not review.entry.capture.keep then
    history.dispose(review.entry.capture)
    self.captures[review.entry.capture] = nil
  end
end

--- Adopt exactly the reviewed disk state, retaining all live text and undo.
--- An ordinary save then records the live checkpoint and retries held imports.
function Session:recover_disk(review)
  assert(self.workspace and not self.stopped and not self.saving and not self.busy, 'RECOVERY_BUSY: Editor is busy')
  assert(review.revision == self.revision, 'STALE_REVISION: Inspect recovery again before accepting')
  self:_wait_request('recoverDisk', { choice = 'keep-current', inspection = review.disk })
  self.paused, self.history_limit, self.dirty = false, false, true
  self:_schedule()
end

function M.get(buf) return owners[buf or vim.api.nvim_get_current_buf()] end

--- Detach callbacks, preserving any unconfirmed captures for recovery. No buffer
--- is deleted and no project writer is closed by detaching one document.
function Session:stop()
  if not self.stopped then
    if
      vim.api.nvim_buf_is_valid(self.buf)
      and vim.api.nvim_buf_is_loaded(self.buf)
      and (self.dirty or self.seen_tick ~= vim.api.nvim_buf_get_changedtick(self.buf))
    then
      -- Freeze edits that have not reached the scheduled checkpoint yet. Stop
      -- does not require a live bridge and never saves or replaces source text.
      local ok, err = pcall(function() self:_capture() end)
      if not ok then self:_fail(err) end
    end
    self.stopped = true
    vim.api.nvim_del_augroup_by_id(self.group)
    bridge.off_event('syncChanged', self.remote_event)
    if self.workspace and vim.api.nvim_buf_is_valid(self.buf) then vim.bo[self.buf].autoread = self.autoread end
    if owners[self.buf] == self then owners[self.buf] = nil end
  end
  local paths = {}
  for capture in pairs(self.captures) do
    capture.keep = true
    paths[#paths + 1] = capture.directory
  end
  return paths
end

--- Explicitly restore an archived editor after project reopen. Both the current
--- and archived checkpoints are durable before native text/history replacement.
local function reattach(buf, binding, opts, restore)
  opts = opts or {}
  assert(not owners[buf] and present(binding.workspace), 'Stop the attached editor before restoring its archive')
  local saved, check_path = workspace_reader(buf, binding.workspace)
  local context = setmetatable({
    buf = buf,
    session = binding.session,
    document = binding.document,
    revision = binding.revision,
    state = binding.state,
    workspace = true,
    source_path = binding.workspace.path,
    source_root = binding.workspace.root,
    capture_directory = opts.capture_directory,
    request = opts.request or bridge.request,
    captures = {},
    check_path = check_path,
  }, Session)
  local before = context:_capture()
  local after
  local ok, result = pcall(function()
    if not restore then
      local accepted = context:_wait_request('useEditor', { checkpoint = before.checkpoint, expected = saved() })
      return M.attach(buf, accepted, opts)
    end
    local proposal = context:_wait_request('prepareReattach', { checkpoint = before.checkpoint })
    local disk = saved()
    assert(disk == proposal.state.disk.content, 'STALE_DISK: Source changed before restoring the archive')
    history.restore(before.capture, proposal.result.checkpoint, disk ~= proposal.result.writeContent)
    after = context:_capture()
    local accepted =
      context:_wait_request('acceptReattach', { token = proposal.result.token, checkpoint = after.checkpoint })
    return M.attach(buf, accepted, opts)
  end)
  if not ok then
    local paths = {}
    for capture in pairs(context.captures) do
      capture.keep = true
      paths[#paths + 1] = capture.directory
    end
    error({ code = 'EDITOR_RECOVERY_REQUIRED', message = vim.inspect(result), recovery = paths }, 0)
  end
  history.dispose(before.capture)
  if after then history.dispose(after.capture) end
  return result
end

function M.restore(buf, binding, opts) return reattach(buf, binding, opts, true) end

--- Retain the current native buffer and archive any displaced recovery state.
--- Independently dirty text is held as a separate branch, never auto-published.
function M.use_current(buf, binding, opts) return reattach(buf, binding, opts, false) end

--- Bind an already opened engine document to an ordinary buffer. The workspace
--- must supply disk comparison and resolve recovered checkpoints before attach.
--- This controller is not attached by the plugin's legacy editing path.
function M.attach(buf, binding, opts)
  opts = opts or {}
  assert(vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == '', 'An ordinary loaded file buffer is required')
  assert(not owners[buf], 'Buffer already has an editor session')
  local saved, check_path
  local workspace = present(binding.workspace)
  if workspace then
    saved, check_path = workspace_reader(buf, binding.workspace)
    check_path()
    for _, autocmd in ipairs(vim.api.nvim_get_autocmds({ event = { 'BufWriteCmd', 'FileWriteCmd', 'FileAppendCmd' } })) do
      assert(
        not matches_write_handler(autocmd, buf),
        'WRITE_HANDLER_CONFLICT: A custom write handler already owns this buffer'
      )
    end
  else
    assert(type(opts.modified) == 'function', 'The workspace must supply a disk comparison')
    assert(type(opts.saved) == 'function', 'The workspace must supply a synchronous saved-file observation')
  end
  assert(
    not binding.state.editorAttached or (present(binding.result) and binding.result.status == 'reattached'),
    'Recover or detach the existing native editor checkpoint first'
  )
  local self = setmetatable({
    buf = buf,
    session = binding.session,
    document = binding.document,
    revision = binding.revision,
    state = binding.state,
    modified = opts.modified,
    saved = saved or opts.saved,
    check_path = check_path,
    workspace = workspace,
    source_path = workspace and binding.workspace.path or nil,
    source_root = workspace and binding.workspace.root or nil,
    disk_content = workspace and binding.state.disk.content or nil,
    autoread = vim.bo[buf].autoread,
    request = opts.request or bridge.request,
    on_status = opts.on_status,
    on_change = opts.on_change,
    capture_directory = opts.capture_directory,
    captures = {},
    saves = {},
    active = {},
    dirty = true,
  }, Session)
  self.group = vim.api.nvim_create_augroup('OverleafEditor' .. buf, { clear = true })
  if workspace then
    vim.bo[buf].autoread = false
    assert(
      vim.api.nvim_buf_attach(buf, false, {
        on_changedtick = function()
          if self.stopped then return true end
          if self.checking_modified then return end
          -- Native undo/redo emits this after restoring text and its old modified
          -- flag. Correct it synchronously: TextChanged runs too late for commands
          -- such as `undo | bdelete`. Read actual disk, including unseen changes.
          self.checking_modified = true
          local ok, matches = pcall(function() return matches_disk(buf, self.saved()) end)
          vim.bo[buf].modified = not (ok and matches)
          self.checking_modified = false
          self:refresh()
        end,
      }),
      'Could not attach saved-state tracking'
    )
    vim.api.nvim_create_autocmd('FileChangedShell', {
      group = self.group,
      buffer = buf,
      callback = function()
        vim.v.fcs_choice = ''
        self:refresh()
      end,
    })
    vim.api.nvim_create_autocmd('OptionSet', {
      group = self.group,
      pattern = 'autoread',
      callback = function()
        if vim.api.nvim_get_current_buf() == buf then vim.bo[buf].autoread = false end
      end,
    })
    self.write_autocmd = vim.api.nvim_create_autocmd('BufWriteCmd', {
      nested = true,
      group = self.group,
      buffer = buf,
      callback = function(event) self:_write(event) end,
    })
    vim.api.nvim_create_autocmd({ 'FileWriteCmd', 'FileAppendCmd' }, {
      group = self.group,
      buffer = buf,
      callback = function()
        error('UNSUPPORTED_WRITE: Partial writes and appends are not supported for bound sources', 0)
      end,
    })
  end
  self.remote_event = function(event)
    if event.session == self.session and event.document == self.document then self:refresh() end
  end
  bridge.on_event('syncChanged', self.remote_event)
  vim.api.nvim_create_autocmd('ModeChanged', {
    group = self.group,
    callback = function()
      if self.dirty and not interacting() then self:_schedule() end
    end,
  })
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
      if self.workspace then return end
      local ok, entry = pcall(function()
        local captured = self:_capture()
        captured.saved = self.saved()
        assert(type(captured.saved) == 'string', 'Saved-file observation must return exact bytes')
        self.last_saved = captured.saved
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

--- Called before bridge shutdown so final native edits remain locally readable
--- even if the process cannot accept another checkpoint.
function M.stop_all()
  for _, controller in pairs(vim.tbl_values(owners)) do
    local ok, paths = pcall(controller.stop, controller)
    if not ok then
      vim.notify('[overleaf] Editor recovery failed: ' .. tostring(paths), vim.log.levels.ERROR)
    elseif #paths > 0 then
      vim.notify('[overleaf] Retained editor recovery: ' .. table.concat(paths, ', '))
    end
  end
end

return M
