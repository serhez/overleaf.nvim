local M = {}
local View = {}
View.__index = View
local next_id = 0

local function present(value) return value ~= nil and value ~= vim.NIL end

local function rpc(request, method, fields)
  local done, failure, result = false, nil, nil
  request(method, fields, function(err, reply)
    failure, result, done = err, reply, true
  end)
  assert(vim.wait(30000, function() return done end, 10), 'RECOVERY_PENDING: Inspect again before retrying')
  if failure then error(failure, 0) end
  return result
end

local function set(buf, content)
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(content, '\n', { plain = true }))
  vim.bo[buf].modified, vim.bo[buf].modifiable = false, false
end

local function scratch(name, content)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].bufhidden, vim.bo[buf].swapfile, vim.bo[buf].modeline = 'hide', false, false
  set(buf, content)
  return buf
end

function View:show(name)
  local buf = assert(self.buffers[name], 'Unknown recovery view')
  assert(vim.api.nvim_tabpage_is_valid(self.tab), 'Recovery tab was closed')
  vim.api.nvim_set_current_tabpage(self.tab)
  vim.api.nvim_set_current_win(self.content_window)
  vim.api.nvim_win_set_buf(self.content_window, buf)
  self.selected = name
end

function View:accept()
  assert(not self.accepted, 'Recovery review was already accepted')
  self.session:recover_disk(self.review)
  self.accepted = true
  set(self.summary, self.description .. '\n\nDisk baseline accepted. Save the source buffer to continue.')
end

function View:close()
  local owned = { [self.summary] = true }
  for _, buf in pairs(self.buffers) do
    owned[buf] = true
  end
  for buf in pairs(owned) do
    assert(
      not vim.api.nvim_buf_is_valid(buf) or not vim.bo[buf].modified,
      'UNSAVED_RESOLUTION: Write the result to accept it, or explicitly discard its buffer before closing'
    )
  end
  if vim.api.nvim_tabpage_is_valid(self.tab) then
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(self.tab)) do
      if owned[vim.api.nvim_win_get_buf(win)] then pcall(vim.api.nvim_win_close, win, false) end
    end
  end
  for buf in pairs(owned) do
    if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
  end
  if self.on_close then self.on_close() end
end

--- Inspect project ownership after a failed open. The bridge rechecks every
--- owner on explicit acceptance; a UI label never authorizes removing a lock.
function M.locks(params, opts)
  opts = opts or {}
  local request = opts.request or require('overleaf.bridge').request
  local review = rpc(request, 'syncInspectLocks', params)
  local description = { 'Overleaf project ownership', '', review.directory, '' }
  for _, lock in ipairs(review.locks) do
    local owner = lock.inspection.owner
    description[#description + 1] = lock.label
      .. ': '
      .. lock.inspection.state
      .. (present(owner) and (' (PID ' .. owner.pid .. ' on ' .. owner.host .. ')') or '')
    description[#description + 1] = lock.inspection.directory .. '/writer.lock'
  end
  description[#description + 1] = '\na: release confirmed dead local writers; q: close'
  description[#description + 1] =
    'Running and unknown owners cannot be released here. Source files and recovery snapshots are retained.'
  next_id = next_id + 1
  local view = setmetatable({ buffers = {}, review = review }, View)
  view.description = table.concat(description, '\n')
  view.summary = scratch('overleaf-recovery://' .. next_id .. '/ownership', view.description)
  function view:accept()
    assert(not self.accepted, 'Recovery review was already accepted')
    local result = rpc(request, 'syncRecoverLocks', { review = self.review })
    self.accepted = true
    set(
      self.summary,
      self.description .. '\n\nOwnership released. Retained records:\n' .. table.concat(result.retained, '\n')
    )
    if opts.on_recovered then opts.on_recovered(result) end
  end
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  for key, action in pairs({ a = function() view:accept() end, q = function() view:close() end }) do
    vim.keymap.set('n', key, function()
      local ok, err = pcall(action)
      if not ok then vim.notify('[overleaf] ' .. vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = view.summary, silent = true })
  end
  return view
end

function M.relocation(session, opts)
  opts = opts or {}
  local review = session:review_relocation()
  if not present(review.workspace) then
    local choices = vim.tbl_extend('force', opts.local_choices or {}, { notice = review.workspaceError.message })
    return M.lifecycle(session, choices)
  end
  next_id = next_id + 1
  local view = setmetatable({ review = review, buffers = {} }, View)
  view.description = table.concat({
    'Overleaf source rename',
    '',
    'Current path: ' .. review.workspace.from,
    'Remote path:  ' .. review.workspace.to,
    '',
    'a: accept the new path    q: close',
    '',
    'The saved file is copied to the new path. The old file and its undo file remain.',
    'Your open buffer keeps its unsaved edits and undo history.',
    'An existing destination file or buffer must be retained elsewhere before accepting.',
  }, '\n')
  view.summary = scratch('overleaf-recovery://' .. next_id .. '/rename', view.description)
  function view:accept()
    assert(not self.accepted, 'Rename review was already accepted')
    local result
    if opts.accept then
      result = opts.accept(self.review)
    else
      result = session:relocate(self.review)
    end
    self.accepted = true
    set(self.summary, self.description .. '\n\nNow editing: ' .. result.workspace.path)
  end
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  for key, action in pairs({ a = function() view:accept() end, q = function() view:close() end }) do
    vim.keymap.set('n', key, function()
      local ok, err = pcall(action)
      if not ok then vim.notify('[overleaf] ' .. vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = view.summary, silent = true })
  end
  return view
end

function M.lifecycle(session, opts)
  opts = opts or {}
  local review = session:review_lifecycle()
  next_id = next_id + 1
  local view = setmetatable({ review = review, buffers = {} }, View)
  view.description = table.concat({
    'Overleaf file identity: ' .. review.lifecycle.path,
    'Status: ' .. review.lifecycle.reason,
    opts.notice or '',
    '',
    'l: keep this file locally and stop syncing it    q: close',
    '',
    present(review.workspace) and ('a: keep a separate local copy at ' .. review.workspace.to)
      or ('Archive unavailable: ' .. review.workspaceError.message),
    'This frees the original path for a replacement remote file.',
    '',
    'The source file, unsaved buffer, and undo history are retained.',
    'Previous remote targets and upload intents remain in recovery storage.',
    'Already submitted changes may still reach Overleaf; no further changes will be sent.',
    'A replacement remote file keeps its own identity and cannot take over this path.',
  }, '\n')
  view.summary = scratch('overleaf-recovery://' .. next_id .. '/identity', view.description)
  function view:accept()
    assert(not self.accepted, 'Lifecycle review was already accepted')
    local result
    if opts.accept then
      result = opts.accept(self.review)
    else
      result = session:keep_local(self.review)
    end
    self.accepted = true
    set(self.summary, self.description .. '\n\nKept locally. Ordinary saves remain available.')
    return result
  end
  function view:archive()
    assert(not self.accepted, 'Lifecycle review was already accepted')
    assert(present(self.review.workspace), 'Review an available archive destination first')
    local result
    if opts.archive then
      result = opts.archive(self.review)
    else
      result = session:relocate(self.review, true)
    end
    self.accepted = true
    set(self.summary, self.description .. '\n\nKept locally at: ' .. result.workspace.path)
    return result
  end
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  for key, action in pairs({
    l = function() view:accept() end,
    a = function() view:archive() end,
    q = function() view:close() end,
  }) do
    vim.keymap.set('n', key, function()
      local ok, err = pcall(action)
      if not ok then vim.notify('[overleaf] ' .. vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = view.summary, silent = true })
  end
  return view
end

local function hex_preview(encoded)
  local bytes = vim.base64.decode(encoded)
  local lines = { tostring(#bytes) .. ' bytes', '' }
  local limit = math.min(#bytes, 4096)
  for offset = 1, limit, 16 do
    local row = {}
    for index = offset, math.min(offset + 15, limit) do
      row[#row + 1] = string.format('%02x', bytes:byte(index))
    end
    lines[#lines + 1] = string.format('%08x  %s', offset - 1, table.concat(row, ' '))
  end
  if #bytes > limit then
    lines[#lines + 1] = 'Preview limited to the first 4096 bytes; complete versions remain in recovery storage.'
  end
  return table.concat(lines, '\n')
end

--- Binary review never treats missing text markers as a resolved conflict.
--- Each choice refers to the exact inspected source and retained remote bytes.
function M.asset_lifecycle(asset, opts)
  opts = opts or {}
  local request = opts.request or require('overleaf.bridge').request
  local review =
    rpc(request, 'syncAssetLifecycle', { session = asset.session, document = asset.document, action = 'review' })
  next_id = next_id + 1
  local view = setmetatable({ review = review, buffers = {} }, View)
  view.description = table.concat({
    'Overleaf binary file identity: ' .. review.lifecycle.path,
    'Status: ' .. review.lifecycle.reason,
    '',
    present(review.relocation) and ('r: accept remote path ' .. review.relocation.to) or present(
      review.relocationError
    ) and ('Rename unavailable: ' .. review.relocationError.message) or 'The remote file no longer has this identity.',
    'l: keep the file locally and stop following Overleaf',
    present(review.archive) and ('a: keep a separate local copy at ' .. review.archive.to)
      or ('Archive unavailable: ' .. review.archiveError.message),
    'q: close',
    '',
    'Existing files are retained. Occupied destinations are never overwritten.',
  }, '\n')
  view.summary = scratch('overleaf-recovery://' .. next_id .. '/binary-identity', view.description)
  function view:accept(choice)
    assert(not self.accepted, 'Lifecycle review was already accepted')
    assert(choice == 'rename' or choice == 'local' or choice == 'archive', 'Select a lifecycle choice')
    assert(choice ~= 'rename' or present(self.review.relocation), 'Review an available rename destination first')
    assert(choice ~= 'archive' or present(self.review.archive), 'Review an available archive destination first')
    local ok, result = pcall(rpc, request, 'syncAssetLifecycle', {
      session = asset.session,
      document = asset.document,
      action = choice,
      review = self.review,
    })
    if not ok then
      local inspected, current = pcall(rpc, request, 'syncAssetLifecycle', {
        session = asset.session,
        document = asset.document,
        action = 'state',
      })
      local expected = choice == 'rename' and present(self.review.relocation) and self.review.relocation.to
        or choice == 'archive' and self.review.archive.to
        or self.review.lifecycle.path
      if inspected and current.state.path == expected and (choice == 'rename' or current.state.localOnly) then
        ok, result = true, current
      end
    end
    if not ok then error(result, 0) end
    self.accepted = true
    set(self.summary, self.description .. '\n\nAccepted: ' .. result.state.path .. ' (' .. result.state.status .. ')')
    if opts.on_resolved then opts.on_resolved(result) end
    return result
  end
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  for key, action in pairs({
    r = function() view:accept('rename') end,
    l = function() view:accept('local') end,
    a = function() view:accept('archive') end,
    q = function() view:close() end,
  }) do
    vim.keymap.set('n', key, function()
      local ok, err = pcall(action)
      if not ok then vim.notify('[overleaf] ' .. vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = view.summary, silent = true })
  end
  return view
end

function M.asset(review, opts)
  opts = opts or {}
  if present(review.state.lifecycle) then return M.asset_lifecycle(review, opts) end
  review = vim.deepcopy(review)
  local request = opts.request or require('overleaf.bridge').request
  next_id = next_id + 1
  local prefix = 'overleaf-recovery://' .. next_id .. '/'
  local view = setmetatable({ review = review, buffers = {} }, View)
  view.description = table.concat({
    'Overleaf binary file: ' .. review.state.path,
    'Status: ' .. review.state.status,
    '',
    'l: keep the inspected local file    r: use the reviewed Overleaf file',
    '1: original bytes    2: current local bytes    3: Overleaf bytes    q: close',
    '',
    'Choosing local does not upload it. Previous versions remain in recovery storage.',
    'An interrupted write must first be reviewed and kept as the current local file.',
  }, '\n')
  view.summary = scratch(prefix .. 'binary-review', view.description)
  local versions = {
    local_bytes = review.observation.observed.bytes,
    remote_bytes = review.state.remote,
    base_bytes = present(review.state.conflict) and review.state.conflict.base or nil,
  }
  for name, encoded in pairs(versions) do
    if present(encoded) then view.buffers[name] = scratch(prefix .. name, hex_preview(encoded)) end
  end
  function view:accept(choice)
    assert(not self.accepted, 'Recovery review was already accepted')
    assert(choice == 'local' or choice == 'remote', 'Select a binary branch explicitly')
    local result = rpc(request, 'syncAsset', {
      session = self.review.session,
      document = self.review.document,
      path = self.review.state.path,
      revision = self.review.revision,
      observation = self.review.observation,
      choice = choice,
    })
    self.accepted = true
    set(self.summary, self.description .. '\n\nAccepted: ' .. choice .. ' (' .. result.state.status .. ')')
    if opts.on_resolved then opts.on_resolved(result) end
  end
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  vim.cmd('belowright vsplit')
  view.content_window = vim.api.nvim_get_current_win()
  local initial = view.buffers.local_bytes and 'local_bytes' or 'remote_bytes'
  if view.buffers[initial] then view:show(initial) end
  local actions = {
    l = function() view:accept('local') end,
    r = function() view:accept('remote') end,
    q = function() view:close() end,
  }
  for key, name in pairs({ ['1'] = 'base_bytes', ['2'] = 'local_bytes', ['3'] = 'remote_bytes' }) do
    if view.buffers[name] then actions[key] = function() view:show(name) end end
  end
  for _, buf in ipairs(vim.list_extend({ view.summary }, vim.tbl_values(view.buffers))) do
    for key, action in pairs(actions) do
      vim.keymap.set('n', key, function()
        local ok, err = pcall(action)
        if not ok then vim.notify('[overleaf] ' .. vim.inspect(err), vim.log.levels.ERROR) end
      end, { buffer = buf, silent = true })
    end
  end
  return view
end

--- Unknown delivery is not a text merge decision. Inspect a fresh server head
--- first, then explicitly retire the old intent into an unresolved text review.
function M.upload(session, opts)
  opts = opts or {}
  session = session or require('overleaf.editor.session').get()
  assert(session, 'No workspace editor is attached')
  local request = session.request or require('overleaf.bridge').request
  local review = rpc(request, 'syncUploadReview', { session = session.session, document = session.document })
  if review.status == 'recovered' then
    session:refresh()
    vim.notify('[overleaf] Server history confirmed the upload outcome')
    return nil
  end
  next_id = next_id + 1
  local prefix = 'overleaf-upload://' .. next_id .. '/'
  local description = table.concat({
    'Upload outcome unknown',
    '',
    'The old submission is retained. Matching text alone does not prove whether it was accepted.',
    review.canRetire and 'The original queue receipt is retained, and the server confirms its queue has drained.'
      or 'The original queue receipt or queue-draining contract is missing; the operation remains held.',
    '',
    'a: retain the old intent and start an explicit text conflict review',
    'This does not resend the operation or accept either text branch.',
    opts.detach and 'l: keep this file local only; its old remote outcome remains unknown' or '',
    'b: original base  i: submitted text  s: saved target  u: unsaved buffer  t: server head  q: close',
  }, '\n')
  local view = setmetatable({ session = session, review = review, description = description, buffers = {} }, View)
  view.summary = scratch(prefix .. 'review', description)
  for name, content in pairs({
    base = review.pending.base,
    submitted = review.pending.content,
    saved = review.saved,
    buffer = review.buffer,
    remote = review.remote.content,
    operation = vim.inspect(review.pending.operation),
  }) do
    view.buffers[name] = scratch(prefix .. name, content)
  end
  function view:accept()
    assert(not self.accepted, 'Upload review already accepted')
    assert(self.review.canRetire, 'QUEUE_NOT_DRAINED: The server has not confirmed its old queue is complete')
    local result = rpc(
      request,
      'syncUploadReview',
      { session = session.session, document = session.document, accept = true, review = self.review }
    )
    self.accepted = true
    session:refresh()
    set(
      self.summary,
      self.description
        .. '\n\n'
        .. (
          result.status == 'recovered' and 'Server history confirmed the outcome.'
          or 'Old intent retained. Return to the source and :Overleaf resolve to review text and undo history.'
        )
    )
  end
  function view:detach()
    assert(not self.accepted, 'Upload review already accepted')
    assert(opts.detach, 'Local-only retention is unavailable for this review')
    opts.detach(self.review)
    self.accepted = true
    set(
      self.summary,
      self.description .. '\n\nFile kept local only. Original upload intent retained; remote outcome unknown.'
    )
  end
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  vim.cmd('belowright vsplit')
  view.content_window = vim.api.nvim_get_current_win()
  view:show('submitted')
  local buffers = { view.summary }
  for _, buf in pairs(view.buffers) do
    buffers[#buffers + 1] = buf
  end
  for _, buf in ipairs(buffers) do
    for key, name in pairs({ b = 'base', i = 'submitted', s = 'saved', u = 'buffer', t = 'remote', o = 'operation' }) do
      vim.keymap.set('n', key, function() view:show(name) end, { buffer = buf })
    end
    vim.keymap.set('n', 'a', function()
      local ok, err = pcall(view.accept, view)
      if not ok then vim.notify(vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = buf })
    if opts.detach then
      vim.keymap.set('n', 'l', function()
        local ok, err = pcall(view.detach, view)
        if not ok then vim.notify(vim.inspect(err), vim.log.levels.ERROR) end
      end, { buffer = buf })
    end
    vim.keymap.set('n', 'q', function() view:close() end, { buffer = buf })
  end
  return view
end

--- Inspect local save recovery. Merely opening or closing a review never
--- accepts a candidate or replaces source text. Acceptance is a separate action.
function M.recovery(session)
  session = session or require('overleaf.editor.session').get()
  assert(session, 'No workspace editor is attached to this buffer')
  local review = session:inspect()
  next_id = next_id + 1
  local prefix = 'overleaf-recovery://' .. next_id .. '/'
  local state = review.disk.record and review.disk.record.state or {}
  local pending = present(state.pending) and state.pending or {}
  local description = {
    'Overleaf save recovery',
    '',
    present(pending.sourceInstalled) and 'Source installation confirmed; artifacts may be incomplete.'
      or 'No source installation confirmation recorded.',
    'a: accept current disk as baseline; source buffer and undo stay intact',
    'p: restore the selected retained capture as an unsaved, undoable edit',
    'e: export the selected version to a new file; existing paths are refused',
    'r: open a fresh review    q: close this review',
    '',
    'Versions (press the indicated key):',
  }
  if review.held then
    description[#description + 1] = 'Editor held: ' .. tostring(review.held.message)
    description[#description + 1] = 'Correct unsupported buffer options or inspect retained history before resuming.'
  end
  local view = setmetatable({ session = session, review = review, buffers = {}, contents = {} }, View)
  local choices = {}
  local function add(name, key, title, content)
    if not present(content) then return end
    view.buffers[name] = scratch(prefix .. name, content)
    view.contents[name] = content
    choices[#choices + 1] = { key = key, name = name }
    description[#description + 1] = key .. ': ' .. title
  end
  add('disk', 'd', 'Current disk', review.disk.observed.exists and vim.base64.decode(review.disk.observed.bytes) or '')
  add(
    'original',
    'o',
    'Disk before the interrupted write',
    state.observed and vim.base64.decode(state.observed.bytes or '') or ''
  )
  local disk_pending = present(review.state.disk) and review.state.disk.pending
  add('candidate', 'c', 'Interrupted candidate', present(disk_pending) and disk_pending.content or nil)
  add('saved', 's', 'Saved branch', review.state.saved)
  add('buffer', 'u', 'Current native buffer (UTF-8, LF)', review.buffer)
  add('remote', 't', 'Remote branch', review.state.remote.content)
  view.captures = {}
  for index, capture in ipairs(review.captures) do
    view.captures['capture' .. index] = capture
    add('capture' .. index, tostring(index), 'Retained capture: ' .. capture.path, capture.content)
  end
  function view:restore_selected()
    local selected = assert(self.captures[self.selected], 'Select a retained capture before restoring text')
    self.session:restore_capture(self.review, selected)
    set(
      self.summary,
      self.description .. '\n\nCapture restored as unsaved text. Undo remains available in the source buffer.'
    )
  end
  function view:export_selected(filename)
    local content = assert(self.contents[self.selected], 'Select a version before exporting it')
    assert(type(filename) == 'string' and filename ~= '', 'Choose a new file path')
    local uv = vim.uv or vim.loop
    local fd = assert(uv.fs_open(vim.fn.fnamemodify(vim.fn.expand(filename), ':p'), 'wx', 384))
    local written, write_error = uv.fs_write(fd, content, 0)
    local synced, sync_error = uv.fs_fsync(fd)
    local closed, close_error = uv.fs_close(fd)
    assert(
      written == #content and synced and closed,
      write_error or sync_error or close_error or 'Incomplete export retained'
    )
  end
  description[#description + 1] = '\nArtifacts:'
  for _, artifact in ipairs(review.disk.artifacts or {}) do
    description[#description + 1] = artifact.kind
      .. ': '
      .. artifact.path
      .. (artifact.error and (' (' .. artifact.error.code .. ': ' .. artifact.error.message .. ')') or '')
  end
  view.description = table.concat(description, '\n')
  view.summary = scratch(prefix .. 'review', view.description)
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  vim.api.nvim_win_set_buf(0, view.summary)
  vim.cmd('belowright vsplit')
  view.content_window = vim.api.nvim_get_current_win()
  view:show('disk')
  local function map(buf, key, action)
    vim.keymap.set('n', key, function()
      local ok, err = pcall(action)
      if not ok then vim.notify('[overleaf] ' .. vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = buf, silent = true })
  end
  local buffers = { view.summary }
  for _, buf in pairs(view.buffers) do
    buffers[#buffers + 1] = buf
  end
  for _, buf in ipairs(buffers) do
    map(buf, 'a', function() view:accept() end)
    map(buf, 'q', function() view:close() end)
    map(buf, 'r', function() M.recovery(session) end)
    map(buf, 'p', function() view:restore_selected() end)
    map(buf, 'e', function()
      vim.ui.input({ prompt = 'Export selected version to a new file: ', completion = 'file' }, function(filename)
        if not filename or filename == '' then return end
        local ok, err = pcall(view.export_selected, view, filename)
        if not ok then vim.notify('[overleaf] ' .. tostring(err), vim.log.levels.ERROR) end
      end)
    end)
    for _, choice in ipairs(choices) do
      map(buf, choice.key, function() view:show(choice.name) end)
    end
  end
  return view
end

local HistoryView = setmetatable({}, { __index = View })
HistoryView.__index = HistoryView

function HistoryView:render(conflict)
  assert(conflict.status == 'conflict', 'History cannot be resolved here: ' .. vim.inspect(conflict))
  self.conflict = conflict
  set(self.buffers.base, present(conflict.inputs.base) and conflict.inputs.base or '')
  set(self.buffers.local_state, conflict.inputs['local'])
  set(self.buffers.remote, conflict.inputs.remote)
  set(self.buffers.result, present(conflict.candidate) and conflict.candidate or conflict.inputs['local'])
  vim.bo[self.buffers.result].modifiable = not conflict.ready
  local stage = conflict.ready and 'Confirm resolved buffer'
    or conflict.stage == 'saved' and 'Saved text'
    or conflict.stage == 'buffer' and 'Unsaved buffer'
    or ('Undo state ' .. conflict.seq)
  local message = stage .. ': edit result, :write accepts; <leader>c CodeDiff; <leader>q closes'
  if self.document then message = message .. '; <leader>d disk, <leader>s server, <leader>r result' end
  set(self.summary, message)
  vim.wo[self.content_window].winbar = message
end

--- CodeDiff only edits a private draft. Native acceptance still performs all
--- source, revision, and history checks after importing the saved result.
function HistoryView:open_codediff()
  assert(not self.accepted and not self.conflict.ready, 'This review is not editable')
  if vim.fn.exists(':CodeDiff') ~= 2 or not present(self.conflict.inputs.base) then
    vim.notify('[overleaf] CodeDiff is unavailable for this conflict; use the native result pane')
    return nil
  end
  local redirected = {
    GIT_DIR = true,
    GIT_WORK_TREE = true,
    GIT_INDEX_FILE = true,
    GIT_COMMON_DIR = true,
    GIT_OBJECT_DIRECTORY = true,
    GIT_ALTERNATE_OBJECT_DIRECTORIES = true,
  }
  for name in pairs(vim.fn.environ()) do
    if redirected[name] or name:match('^GIT_CONFIG') then
      vim.notify('[overleaf] Git environment overrides are active; use the native result pane')
      return nil
    end
  end
  local result, conflict = self.buffers.result, self.conflict
  local tick = vim.api.nvim_buf_get_changedtick(result)
  local candidate = table.concat(vim.api.nvim_buf_get_lines(result, 0, -1, false), '\n')
  local adapter = rpc(self.session.request or require('overleaf.bridge').request, 'syncMergeView', {
    session = self.session.session,
    inputs = conflict.inputs,
    candidate = candidate,
  })
  assert(
    vim.api.nvim_buf_is_valid(result) and vim.api.nvim_buf_get_changedtick(result) == tick,
    'STALE_REVIEW: Native draft changed while preparing CodeDiff'
  )
  adapter.buf = vim.fn.bufadd(adapter.path)
  vim.fn.bufload(adapter.buf)
  vim.bo[adapter.buf].swapfile = false
  if self.session.buf and vim.api.nvim_buf_is_valid(self.session.buf) then
    vim.bo[adapter.buf].filetype = vim.bo[self.session.buf].filetype
  end
  vim.api.nvim_create_autocmd('BufWritePost', {
    buffer = adapter.buf,
    callback = function()
      if
        self.accepted
        or self.conflict ~= conflict
        or not vim.api.nvim_buf_is_valid(result)
        or not vim.api.nvim_tabpage_is_valid(self.tab)
        or vim.api.nvim_buf_get_changedtick(result) ~= tick
      then
        vim.notify('[overleaf] Review changed; CodeDiff draft retained at ' .. adapter.path, vim.log.levels.WARN)
        return
      end
      local stat = (vim.uv or vim.loop).fs_lstat(adapter.path)
      if not stat or stat.type ~= 'file' or stat.nlink ~= 1 or stat.size > 16 * 1024 * 1024 then
        vim.notify('[overleaf] Cannot read the CodeDiff draft; native review retained', vim.log.levels.ERROR)
        return
      end
      local file = assert(io.open(adapter.path, 'rb'))
      local content = file:read('*a')
      file:close()
      if content:find('\0', 1, true) then return end
      vim.api.nvim_buf_set_lines(result, 0, -1, false, vim.split(content, '\n', { plain = true }))
      vim.bo[result].modified = true
      tick = vim.api.nvim_buf_get_changedtick(result)
      vim.notify('[overleaf] Draft imported. Return to the native result pane and :write to accept it.')
    end,
  })
  local ok, problem = pcall(vim.cmd, 'CodeDiff merge ' .. vim.fn.fnameescape(adapter.path))
  if not ok then
    vim.notify(
      '[overleaf] CodeDiff could not open; use the native result pane. ' .. tostring(problem),
      vim.log.levels.WARN
    )
  end
  self.adapter = adapter
  return adapter
end

function HistoryView:accept()
  assert(not self.accepted, 'History review was already accepted')
  local choices = vim.deepcopy(self.choices)
  local content = table.concat(vim.api.nvim_buf_get_lines(self.buffers.result, 0, -1, false), '\n')
  -- Complete retained choices need only confirmation, not another text choice.
  if not self.conflict.ready then
    if self.document then
      if self.conflict.stage == 'history' then
        choices.history = choices.history or {}
        choices.history[tostring(self.conflict.seq)] = content
      else
        choices[self.conflict.stage] = content
      end
    else
      choices[tostring(self.conflict.seq)] = content
    end
  end
  local result = self.resolver(self.session, self.review, choices)
  self.choices = choices
  if result.status == 'accepted' then
    self.accepted = true
    vim.bo[self.buffers.result].modified, vim.bo[self.buffers.result].modifiable = false, false
    set(self.summary, 'Resolution accepted. Every native branch is preserved.')
    vim.wo[self.content_window].winbar = 'Resolution accepted'
  else
    self:render(result)
  end
end

--- Native diff panes need no project repository. Every conflicting historical
--- state is reviewed explicitly; only a complete, verified tree is installed.
local function resolution(session, kind)
  local document = kind == 'document'
  session = session or require('overleaf.editor.session').get()
  assert(session, 'No workspace editor is attached to this buffer')
  local review = document and session:review_conflict()
    or kind == 'disk' and session:review_disk_history()
    or session:review_history()
  local resolver = document and session.resolve_conflict
    or kind == 'disk' and session.resolve_disk_history
    or session.resolve_history
  local choices = review.resolutions or {}
  local ok, conflict = pcall(resolver, session, review, choices, true)
  if not ok then
    session:close_history(review)
    error(conflict, 0)
  end
  if conflict.status == 'ready' then
    conflict = vim.tbl_extend('force', review.conflict, {
      status = 'conflict',
      ready = true,
      candidate = conflict.content or (document and choices.saved or choices[tostring(review.conflict.seq)]),
    })
  end
  assert(conflict.status == 'conflict', 'History cannot be reviewed: ' .. vim.inspect(conflict))
  next_id = next_id + 1
  local prefix = 'overleaf-history://' .. next_id .. '/'
  local view = setmetatable(
    { session = session, review = review, choices = choices, buffers = {}, resolver = resolver, document = document },
    HistoryView
  )
  view.summary = scratch(prefix .. 'review', '')
  for _, name in ipairs({ 'base', 'local_state', 'remote', 'result' }) do
    view.buffers[name] = scratch(prefix .. name, '')
  end
  if document then
    local evidence = review.conflict or conflict
    for _, name in ipairs({ 'disk', 'server' }) do
      view.buffers[name] = scratch(prefix .. name, present(evidence[name]) and evidence[name] or '')
    end
    for _, name in ipairs({ 'base', 'local', 'remote' }) do
      local original = evidence.original
      if original and present(original[name]) then
        view.buffers['original_' .. name] = scratch(prefix .. 'original_' .. name, original[name])
      end
    end
  end
  vim.bo[view.buffers.result].buftype, vim.bo[view.buffers.result].buflisted = 'acwrite', true
  vim.cmd('tab split')
  view.tab = vim.api.nvim_get_current_tabpage()
  for index, name in ipairs({ 'base', 'local_state', 'remote' }) do
    if index > 1 then vim.cmd('belowright vsplit') end
    vim.api.nvim_win_set_buf(0, view.buffers[name])
    vim.wo.winbar = name == 'local_state' and (document and 'Local branch' or 'Your historical state')
      or name == 'base' and 'Before incoming edit'
      or 'Current incoming target'
    vim.cmd('diffthis')
  end
  vim.cmd('botright split')
  view.content_window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(0, view.buffers.result)
  vim.cmd('diffthis')
  view:render(conflict)
  view.on_close = function() session:close_history(review) end
  vim.api.nvim_create_autocmd('BufWriteCmd', {
    buffer = view.buffers.result,
    callback = function()
      local accepted, err = pcall(view.accept, view)
      if not accepted then error(vim.inspect(err), 0) end
    end,
  })
  for _, buf in pairs(view.buffers) do
    vim.keymap.set('n', '<leader>c', function()
      local opened, err = pcall(view.open_codediff, view)
      if not opened then vim.notify(vim.inspect(err), vim.log.levels.ERROR) end
    end, { buffer = buf, silent = true })
    vim.keymap.set('n', '<leader>q', function()
      local closed, err = pcall(view.close, view)
      if not closed then vim.notify(tostring(err), vim.log.levels.ERROR) end
    end, { buffer = buf, silent = true })
    if document then
      for key, name in pairs({
        d = 'disk',
        s = 'server',
        r = 'result',
        b = 'original_base',
        l = 'original_local',
        o = 'original_remote',
      }) do
        if view.buffers[name] then
          vim.keymap.set('n', '<leader>' .. key, function() view:show(name) end, { buffer = buf, silent = true })
        end
      end
    end
  end
  return view
end

function M.history(session) return resolution(session, 'history') end

function M.resolve(session) return resolution(session, 'document') end

function M.disk_history(session) return resolution(session, 'disk') end

return M
