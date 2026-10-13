local M = {}
local uv = vim.uv or vim.loop
local MAX_NODES, MAX_BYTES = 1000, 16 * 1024 * 1024
local option_names = { 'endofline', 'fixendofline', 'fileformat', 'fileencoding', 'binary', 'bomb', 'undolevels' }

local function fail(code, message) error(code .. ': ' .. message, 0) end

local function text(buf)
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  for _, line in ipairs(lines) do
    if line:find('\n', 1, true) or line:find('\0', 1, true) then
      fail('INVALID_HISTORY', 'Binary buffer text cannot be rebased')
    end
  end
  return table.concat(lines, '\n')
end

local function empty(buf)
  return vim.api.nvim_buf_call(buf, function() return vim.fn.wordcount().chars == 0 end)
end

local function set(buf, content, is_empty)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, is_empty and {} or vim.split(content, '\n', { plain = true }))
  vim.bo[buf].undolevels = vim.bo[buf].undolevels
end

local function line_offsets(content)
  local offsets = { 0 }
  for at in content:gmatch('()\n') do
    offsets[#offsets + 1] = at
  end
  offsets[#offsets + 1] = #content + 1
  return offsets
end

local function position(offsets, byte)
  local low, high = 1, #offsets - 1
  while low < high do
    local middle = math.ceil((low + high) / 2)
    if offsets[middle] <= byte then
      low = middle
    else
      high = middle - 1
    end
  end
  return low - 1, byte - offsets[low]
end

-- Diff lines first, then Unicode characters only inside changed blocks. Hex
-- tokens let libxdiff distinguish a literal newline from its token separator.
local function edits(before, after)
  local old_lines, new_lines = line_offsets(before), line_offsets(after)
  local result = {}
  local function tokens(value)
    local lines, offsets, byte = {}, { 0 }, 0
    for char in value:gmatch('[%z\1-\127\194-\244][\128-\191]*') do
      lines[#lines + 1] = (char:gsub('.', function(c) return string.format('%02x', c:byte()) end)) .. '\n'
      byte = byte + #char
      offsets[#offsets + 1] = byte
    end
    assert(byte == #value, 'INVALID_HISTORY: Invalid UTF-8 text')
    return table.concat(lines), offsets
  end
  for _, change in ipairs(vim.diff(before .. '\n', after .. '\n', { result_type = 'indices' })) do
    local old_start = old_lines[change[2] == 0 and change[1] + 1 or change[1]]
    local new_start = new_lines[change[4] == 0 and change[3] + 1 or change[3]]
    local old_end = old_lines[change[2] == 0 and change[1] + 1 or change[1] + change[2]]
    local new_end = new_lines[change[4] == 0 and change[3] + 1 or change[3] + change[4]]
    old_start, old_end = math.min(old_start, #before), math.min(old_end, #before)
    new_start, new_end = math.min(new_start, #after), math.min(new_end, #after)
    -- At EOF, a new/deleted line also owns the preceding separator.
    if old_start == #before and new_start > 0 and change[2] == 0 then new_start = new_start - 1 end
    if new_start == #after and old_start > 0 and change[4] == 0 then old_start = old_start - 1 end
    local left, right = before:sub(old_start + 1, old_end), after:sub(new_start + 1, new_end)
    local prefix = 0
    while prefix < math.min(#left, #right) and left:byte(prefix + 1) == right:byte(prefix + 1) do
      prefix = prefix + 1
    end
    while prefix > 0 and (left:byte(prefix + 1) or 0) >= 128 and (left:byte(prefix + 1) or 0) < 192 do
      prefix = prefix - 1
    end
    local suffix = 0
    while suffix < math.min(#left, #right) - prefix and left:byte(#left - suffix) == right:byte(#right - suffix) do
      suffix = suffix + 1
    end
    while suffix > 0 and left:byte(#left - suffix + 1) >= 128 and left:byte(#left - suffix + 1) < 192 do
      suffix = suffix - 1
    end
    old_start = old_start + prefix
    left, right = left:sub(prefix + 1, #left - suffix), right:sub(prefix + 1, #right - suffix)
    if #left + #right > 262144 then
      fail('HISTORY_LIMIT', 'Changed text block exceeds the position-preserving diff limit')
    end
    local left_tokens, left_offsets = tokens(left)
    local right_tokens, right_offsets = tokens(right)
    for _, part in ipairs(vim.diff(left_tokens, right_tokens, { result_type = 'indices', algorithm = 'histogram' })) do
      local from = left_offsets[part[2] == 0 and part[1] + 1 or part[1]]
      local to = left_offsets[part[2] == 0 and part[1] + 1 or part[1] + part[2]]
      local added = right_offsets[part[4] == 0 and part[3] + 1 or part[3]]
      local added_end = right_offsets[part[4] == 0 and part[3] + 1 or part[3] + part[4]]
      result[#result + 1] = { from = old_start + from, to = old_start + to, text = right:sub(added + 1, added_end) }
      if #result > 4096 then fail('HISTORY_LIMIT', 'Too many position-preserving edits') end
    end
  end
  local pieces, last = {}, #before
  for i = #result, 1, -1 do
    local edit = result[i]
    pieces[#pieces + 1] = before:sub(edit.to + 1, last)
    pieces[#pieces + 1] = edit.text
    last = edit.from
  end
  pieces[#pieces + 1] = before:sub(1, last)
  local ordered = {}
  for i = #pieces, 1, -1 do
    ordered[#ordered + 1] = pieces[i]
  end
  assert(table.concat(ordered) == after, 'INVALID_HISTORY: Position-preserving diff does not reconstruct incoming text')
  return result, old_lines, new_lines
end

local function view_state(buf)
  local state = { windows = {}, marks = vim.fn.getmarklist(buf) }
  for _, mark in ipairs(vim.fn.getmarklist()) do
    if mark.pos[1] == buf then state.marks[#state.marks + 1] = mark end
  end
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == buf then state.windows[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview) end
  end
  return state
end

local function restore_view(buf, state, map)
  map = map or function(row, col) return row, col end
  for _, mark in ipairs(state.marks) do
    local pos = vim.deepcopy(mark.pos)
    if pos[2] > 0 then
      local row, col = map(pos[2] - 1, pos[3] - 1)
      pos[2], pos[3] = row + 1, col + 1
      vim.api.nvim_buf_call(buf, function() vim.fn.setpos(mark.mark, pos) end)
    end
  end
  for win, original in pairs(state.windows) do
    if vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_buf(win) == buf then
      local view = vim.deepcopy(original)
      local row, col, display_shift = map(view.lnum - 1, view.col)
      view.lnum, view.col = row + 1, col
      if view.curswant ~= vim.v.maxcol then view.curswant = math.max(0, view.curswant + (display_shift or 0)) end
      view.topline = map(view.topline - 1, 0) + 1
      vim.api.nvim_win_call(win, function() vim.fn.winrestview(view) end)
    end
  end
end

local function position_mapper(before, after, prepared)
  local changes, old_lines, new_lines
  if prepared then
    changes, old_lines, new_lines = unpack(prepared)
  else
    changes, old_lines, new_lines = edits(before, after)
  end
  local function map(row, col)
    row = math.min(row, #old_lines - 2)
    local length = old_lines[row + 2] - old_lines[row + 1] - 1
    local extra = math.max(0, col - length)
    local byte, shift = old_lines[row + 1] + math.min(col, length), 0
    for _, change in ipairs(changes) do
      if byte < change.from then break end
      if byte < change.to then
        byte = change.from
        break
      end
      shift = shift + #change.text - (change.to - change.from)
    end
    local new_byte = math.min(#after, byte + shift)
    local new_row, new_col = position(new_lines, new_byte)
    local display_shift = vim.fn.strdisplaywidth(after:sub(new_lines[new_row + 1] + 1, new_byte))
      - vim.fn.strdisplaywidth(before:sub(old_lines[row + 1] + 1, old_lines[row + 1] + math.min(col, length)))
    return new_row, new_col + extra, display_shift
  end
  return map, changes, old_lines
end

local function replace(buf, before, after, is_empty, prepared)
  local map, changes, old_lines = position_mapper(before, after, prepared)
  local state = view_state(buf)
  if is_empty then
    set(buf, after, true)
  else
    for i = #changes, 1, -1 do
      local change = changes[i]
      local row, col = position(old_lines, change.from)
      local last_row, last_col = position(old_lines, change.to)
      if change.from == change.to and col == 0 and change.text:sub(-1) == '\n' then
        -- Whole-line insertion also moves legacy Neovim jumplist entries on
        -- this line; splitting it with set_text leaves those entries behind.
        vim.api.nvim_buf_set_lines(buf, row, row, false, vim.split(change.text:sub(1, -2), '\n', { plain = true }))
      else
        vim.api.nvim_buf_set_text(buf, row, col, last_row, last_col, vim.split(change.text, '\n', { plain = true }))
      end
    end
    -- The native empty-buffer flag can change even when joined text is equal.
    if #changes == 0 and empty(buf) ~= is_empty then set(buf, after, is_empty) end
  end
  return function() restore_view(buf, state, map) end
end

local function scratch(content, is_empty)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].undolevels = -1
  set(buf, content, is_empty)
  vim.bo[buf].undolevels = MAX_NODES + 1
  return buf
end

local function command(command_name, filename)
  vim.cmd('silent noautocmd ' .. command_name .. ' ' .. vim.fn.fnameescape(filename))
end

local function read_undo(path)
  local stat = assert(uv.fs_stat(path))
  if stat.size > 64 * 1024 * 1024 then fail('HISTORY_HELD', 'Undo file exceeds the metadata limit') end
  local file = assert(io.open(path, 'rb'))
  local data = file:read('*a')
  file:close()
  return assert(data)
end

local function write_undo(path, data)
  local file = assert(io.open(path, 'wb'))
  local written, err = file:write(data)
  local closed, close_error = file:close()
  assert(written, err)
  assert(closed, close_error)
end

local function options(buf)
  local result = {}
  for _, name in ipairs(option_names) do
    result[name] = vim.bo[buf][name]
  end
  return result
end

local function check(snapshot)
  if snapshot.disposed then fail('HISTORY_DISPOSED', 'Undo capture has been disposed') end
  if snapshot.keep then fail('HISTORY_RECOVERY_REQUIRED', 'Inspect recovery files: ' .. snapshot.directory) end
  local buf = snapshot.bufnr
  if
    not vim.api.nvim_buf_is_loaded(buf)
    or vim.api.nvim_buf_get_changedtick(buf) ~= snapshot.changedtick
    or not vim.deep_equal(options(buf), snapshot.options)
    or text(buf) ~= snapshot.content
    or empty(buf) ~= snapshot.empty
    or not vim.deep_equal(vim.api.nvim_buf_call(buf, vim.fn.undotree), snapshot.tree)
  then
    fail('STALE_BUFFER', 'Buffer or undo history changed while preparing the update')
  end
end

--- Capture all native undo states in a scratch buffer; never navigate the user's buffer.
--- The caller owns the capture and must dispose it after acceptance or cancellation.
function M.capture(buf, opts)
  opts = opts or {}
  local parent = opts.directory or uv.os_tmpdir()
  if opts.directory then
    local made, err, code = uv.fs_mkdir(parent, 448)
    if not made and code ~= 'EEXIST' then fail('HISTORY_CAPTURE_FAILED', tostring(err)) end
    local stat = uv.fs_lstat(parent)
    if not stat or stat.type ~= 'directory' or bit.band(stat.mode, 63) ~= 0 then
      fail('HISTORY_CAPTURE_FAILED', 'Recovery directory must be private and cannot be a symlink')
    end
  end
  if not vim.api.nvim_buf_is_loaded(buf) then fail('STALE_BUFFER', 'Buffer is not loaded') end
  -- Finish the current local undo unit before exporting it. :wundo also syncs
  -- native history; subsequent typing must not join a unit being rebased.
  vim.bo[buf].undolevels = vim.bo[buf].undolevels
  local snapshot = {
    bufnr = buf,
    content = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n'),
    empty = empty(buf),
    changedtick = vim.api.nvim_buf_get_changedtick(buf),
    options = options(buf),
    modified = vim.bo[buf].modified,
    directory = assert(uv.fs_mkdtemp(parent .. '/overleaf-history-XXXXXX')),
  }
  local function flush(filename)
    local fd = assert(uv.fs_open(filename, 'r', 384))
    local synced, sync_error = uv.fs_fsync(fd)
    assert(uv.fs_close(fd))
    assert(synced, sync_error)
  end
  local shadow
  local ok, err = pcall(function()
    snapshot.tree = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    snapshot.original = snapshot.directory .. '/original.undo'
    if #snapshot.tree.entries > 0 then
      vim.api.nvim_buf_call(buf, function() command('wundo', snapshot.original) end)
    end
    if vim.bo[buf].binary then fail('INVALID_HISTORY', 'Binary buffers cannot be rebased') end
    text(buf) -- Reject native NULs before attempting to navigate a scratch tree.
    local nodes = { { seq = 0, parent = vim.NIL } }
    local function visit(entries, ancestor)
      for _, entry in ipairs(entries) do
        if entry.alt then visit(entry.alt, ancestor) end
        nodes[#nodes + 1] = { seq = entry.seq, parent = ancestor }
        if #nodes > MAX_NODES then fail('HISTORY_LIMIT', 'Undo history exceeds the automatic rebase limit') end
        ancestor = entry.seq
      end
    end
    visit(snapshot.tree.entries, 0)
    table.sort(nodes, function(a, b) return a.seq < b.seq end)
    local entries = snapshot.tree.entries
    snapshot.history = {
      current = snapshot.tree.seq_cur,
      preferred = #entries > 0 and entries[#entries].seq or 0,
      nodes = nodes,
    }
    shadow = scratch(snapshot.content, snapshot.empty)
    vim.api.nvim_buf_call(shadow, function()
      if #nodes > 1 then command('rundo', snapshot.original) end
      local bytes = 0
      for _, node in ipairs(nodes) do
        if #nodes > 1 then vim.cmd('silent noautocmd undo ' .. node.seq) end
        node.content = text(shadow)
        node.empty = empty(shadow)
        bytes = bytes + #node.content
        if bytes > MAX_BYTES then fail('HISTORY_LIMIT', 'Undo history exceeds the automatic rebase limit') end
      end
    end)
    check(snapshot)
    local backup = vim.json.encode({
      source = vim.api.nvim_buf_get_name(buf),
      document = opts.document,
      session = opts.session,
      content = snapshot.content,
      empty = snapshot.empty,
      options = snapshot.options,
      history = snapshot.history,
    })
    if vim.fn.writefile({ backup }, snapshot.directory .. '/snapshot.json', 'b') ~= 0 then
      fail('HISTORY_CAPTURE_FAILED', 'Could not preserve the original buffer snapshot')
    end
    if opts.directory then
      for _, filename in ipairs({ snapshot.directory .. '/snapshot.json', #nodes > 1 and snapshot.original or nil }) do
        flush(filename)
      end
      flush(snapshot.directory)
      flush(parent)
    end
  end)
  if shadow then vim.api.nvim_buf_delete(shadow, { force = true }) end
  if not ok then
    if opts.directory then
      snapshot.keep = true
      local retained, retain_error = pcall(function()
        local raw = snapshot.directory .. '/buffer.txt'
        local fd = assert(uv.fs_open(raw, 'wx', 384))
        local written, write_error = uv.fs_write(fd, snapshot.content, 0)
        assert(uv.fs_close(fd))
        assert(written == #snapshot.content, write_error or 'Incomplete raw buffer capture')
        flush(raw)
        local backup = vim.json.encode({
          source = vim.api.nvim_buf_get_name(buf),
          document = opts.document,
          session = opts.session,
          content = snapshot.content,
          empty = snapshot.empty,
          options = snapshot.options,
          held = tostring(err),
        })
        assert(vim.fn.writefile({ backup }, snapshot.directory .. '/snapshot.json', 'b') == 0)
        flush(snapshot.directory .. '/snapshot.json')
        if snapshot.original and vim.fn.filereadable(snapshot.original) == 1 then flush(snapshot.original) end
        flush(snapshot.directory)
        flush(parent)
      end)
      err = tostring(err)
        .. '\nRetained recovery: '
        .. snapshot.directory
        .. (retained and '' or ('\nRecovery capture incomplete: ' .. tostring(retain_error)))
    end
    M.dispose(snapshot)
    error(err, 0)
  end
  return snapshot
end

--- Export recovery data for the document engine before proposing a live update.
--- Paths and buffer handles stay local; native bytes travel as JSON-safe base64.
function M.checkpoint(snapshot)
  check(snapshot)
  return {
    history = vim.deepcopy(snapshot.history),
    tree = vim.deepcopy(snapshot.tree),
    options = vim.deepcopy(snapshot.options),
    undo = #snapshot.history.nodes > 1 and vim.base64.encode(read_undo(snapshot.original)) or vim.NIL,
  }
end

--- Export persistent undo bytes for a frozen save, independently of newer live
--- edits. `advance` says whether this save needs native completion metadata.
--- The caller must confirm the source write before publishing these bytes.
--- This only uses private capture files; it never writes to the user's undodir.
function M.saved_undo(snapshot, advance)
  if snapshot.disposed then fail('HISTORY_DISPOSED', 'Undo capture has been disposed') end
  if type(advance) ~= 'boolean' then fail('INVALID_HISTORY', 'Save-marker decision must be explicit') end
  if #snapshot.history.nodes == 1 then return nil end
  local bytes = require('overleaf.editor.undofile').saved(read_undo(snapshot.original), advance)
  local expected = vim.deepcopy(snapshot.tree)
  if advance then
    expected.save_last = expected.save_last + 1
    local function mark(entries)
      for _, entry in ipairs(entries) do
        if entry.seq == snapshot.history.current then entry.save = expected.save_last end
        if entry.alt then mark(entry.alt) end
      end
    end
    mark(expected.entries)
  end
  -- Neovim initializes save_cur from save_last when reopening an undo file.
  expected.save_cur = expected.save_last
  local candidate = snapshot.directory .. '/persistent.undo'
  write_undo(candidate, bytes)
  local shadow = scratch(snapshot.content, snapshot.empty)
  local ok, err = pcall(function()
    vim.api.nvim_buf_call(shadow, function()
      command('rundo', candidate)
      if not vim.deep_equal(vim.fn.undotree(), expected) then
        fail('HISTORY_HELD', 'Persistent undo metadata cannot be restored exactly')
      end
      for _, node in ipairs(snapshot.history.nodes) do
        vim.cmd('silent noautocmd undo ' .. node.seq)
        if text(shadow) ~= node.content or empty(shadow) ~= node.empty then
          fail('HISTORY_HELD', 'Persistent undo text differs from the saved capture')
        end
      end
    end)
  end)
  vim.api.nvim_buf_delete(shadow, { force = true })
  if not ok then error(err, 0) end
  return bytes, expected
end

--- Record an acknowledged save after newer edits prevented native completion.
--- Only metadata is imported; the visible buffer is never navigated or replaced.
--- The caller retains both captures if exact restoration is unsupported.
function M.record_save(snapshot, written)
  check(snapshot)
  if
    snapshot.bufnr ~= written.bufnr
    or snapshot.tree.save_cur ~= snapshot.tree.save_last
    or snapshot.tree.save_last ~= written.tree.save_last
    or #snapshot.history.nodes < 2
  then
    fail('HISTORY_HELD', 'Save marker cannot be restored at this native undo position')
  end
  local nodes = {}
  for _, node in ipairs(snapshot.history.nodes) do
    nodes[node.seq] = node
  end
  for _, node in ipairs(written.history.nodes) do
    if not vim.deep_equal(node, nodes[node.seq]) then
      fail('HISTORY_HELD', 'History no longer contains the captured save states')
    end
  end
  local saved, current = written.history.current, snapshot.history.current
  while current ~= saved do
    if current == 0 then fail('HISTORY_HELD', 'Saved state is not an ancestor of the current buffer') end
    current = nodes[current].parent
  end
  local expected = vim.deepcopy(snapshot.tree)
  expected.save_last = expected.save_last + 1
  expected.save_cur = expected.save_last
  local function mark(entries)
    for _, entry in ipairs(entries) do
      if entry.seq == saved then entry.save = expected.save_last end
      if entry.alt then mark(entry.alt) end
    end
  end
  mark(expected.entries)
  local candidate = snapshot.directory .. '/saved.undo'
  write_undo(candidate, require('overleaf.editor.undofile').record_save(read_undo(snapshot.original), saved))
  local shadow = scratch(snapshot.content, snapshot.empty)
  local function verify(buf, tree)
    if not vim.deep_equal(vim.fn.undotree(), tree) or text(buf) ~= snapshot.content or empty(buf) ~= snapshot.empty then
      fail('HISTORY_HELD', 'Save-marker history cannot be restored exactly')
    end
  end
  local ok, err = pcall(function()
    vim.api.nvim_buf_call(shadow, function()
      command('rundo', snapshot.original)
      verify(shadow, snapshot.tree)
      command('rundo', candidate)
      verify(shadow, expected)
    end)
    check(snapshot)
    local installed, install_error = pcall(function()
      vim.api.nvim_buf_call(snapshot.bufnr, function()
        command('rundo', candidate)
        verify(snapshot.bufnr, expected)
      end)
    end)
    if not installed then
      local restored, restore_error = pcall(function()
        vim.api.nvim_buf_call(snapshot.bufnr, function()
          command('rundo', snapshot.original)
          verify(snapshot.bufnr, snapshot.tree)
        end)
      end)
      if not restored then
        snapshot.keep = true
        fail('HISTORY_RECOVERY_REQUIRED', tostring(restore_error) .. '; recovery files: ' .. snapshot.directory)
      end
      error(install_error, 0)
    end
  end)
  vim.api.nvim_buf_delete(shadow, { force = true })
  if not ok then error(err, 0) end
end

local function validate(snapshot, history)
  if
    type(history) ~= 'table'
    or type(history.nodes) ~= 'table'
    or #history.nodes ~= #snapshot.history.nodes
    or history.current ~= snapshot.history.current
    or history.preferred ~= snapshot.history.preferred
  then
    fail('INVALID_HISTORY', 'Rebased history does not match the captured tree')
  end
  local bytes = 0
  for i, node in ipairs(history.nodes) do
    local original = snapshot.history.nodes[i]
    if
      node.seq ~= original.seq
      or node.parent ~= original.parent
      or type(node.content) ~= 'string'
      or type(node.empty) ~= 'boolean'
      or (node.empty and node.content ~= '')
      or node.content:find('\0', 1, true)
    then
      fail('INVALID_HISTORY', 'Rebased history changed the native tree structure')
    end
    bytes = bytes + #node.content
  end
  if bytes > MAX_BYTES then fail('HISTORY_LIMIT', 'Rebased history exceeds the automatic rebase limit') end
end

--- Install a completely rebased tree. `modified` reflects the accepted disk state,
--- not remote acknowledgement. Returns preserved native sequence IDs.
--- HISTORY_HELD means no live mutation occurred: retain the incoming revision
--- and retry from a fresh capture after a normal save. Never reuse a stale tree.
function M.install(snapshot, history, modified)
  check(snapshot)
  validate(snapshot, history)
  if type(modified) ~= 'boolean' then fail('INVALID_HISTORY', 'Disk modified state must be explicit') end
  if not vim.bo[snapshot.bufnr].modifiable then fail('STALE_BUFFER', 'Buffer is not modifiable') end
  -- :rundo sets save_cur to save_last. Navigating to correct it also changes
  -- time_cur, so it cannot reliably preserve time- and save-based undo together.
  if snapshot.tree.save_cur ~= snapshot.tree.save_last then
    fail('HISTORY_HELD', 'Undo save position cannot be restored exactly; retry after saving')
  end
  local shadow = scratch(history.nodes[1].content, history.nodes[1].empty)
  local verification
  local sequences = { [0] = 0 }
  local candidate = snapshot.directory .. '/candidate.undo'
  local content, tree, is_empty
  local ok, err = pcall(function()
    vim.api.nvim_buf_call(shadow, function()
      for i = 2, #history.nodes do
        local node = history.nodes[i]
        vim.cmd('silent noautocmd undo ' .. sequences[node.parent])
        set(shadow, node.content, node.empty)
        sequences[node.seq] = vim.fn.undotree().seq_cur
      end
      if #history.nodes > 1 then
        vim.cmd('silent noautocmd undo ' .. sequences[history.preferred])
        vim.cmd('silent noautocmd undo ' .. sequences[history.current])
        command('wundo', candidate)
      end
      content, tree, is_empty = text(shadow), vim.fn.undotree(), empty(shadow)
    end)
    if #history.nodes > 1 then
      local originals, targets, maps = {}, {}, {}
      for i, node in ipairs(snapshot.history.nodes) do
        originals[node.seq], targets[node.seq] = node, history.nodes[i]
      end
      local function historical_cursor(seq, row, col)
        local parent = originals[seq].parent
        if not maps[parent] then maps[parent] = position_mapper(originals[parent].content, targets[parent].content) end
        return maps[parent](row, col)
      end
      local candidate_bytes = require('overleaf.editor.undofile').restore(
        read_undo(snapshot.original),
        read_undo(candidate),
        sequences,
        historical_cursor
      )
      write_undo(candidate, candidate_bytes)
      -- Verify both rollback and candidate imports in a disposable buffer before
      -- clearing any live history. Native :rundo can reject a file silently.
      verification = scratch(snapshot.content, snapshot.empty)
      vim.api.nvim_buf_call(verification, function()
        command('rundo', snapshot.original)
        if not vim.deep_equal(vim.fn.undotree(), snapshot.tree) or empty(verification) ~= snapshot.empty then
          fail('HISTORY_HELD', 'Original undo history cannot be restored exactly')
        end
        vim.bo[verification].undolevels = -1
        set(verification, content, is_empty)
        vim.bo[verification].undolevels = MAX_NODES + 1
        command('rundo', candidate)
        tree = vim.fn.undotree()
        if
          not vim.deep_equal(tree, snapshot.tree)
          or text(verification) ~= content
          or empty(verification) ~= is_empty
        then
          fail('HISTORY_HELD', 'Candidate undo history cannot be restored exactly')
        end
      end)
      for seq in pairs(sequences) do
        sequences[seq] = seq
      end
    elseif not vim.deep_equal(tree, snapshot.tree) then
      fail('HISTORY_HELD', 'Empty undo history cannot be restored exactly')
    end
    check(snapshot)
    local buf = snapshot.bufnr
    local prepared = { edits(snapshot.content, content) }
    local original_view = view_state(buf)
    local installed, install_error = pcall(function()
      vim.api.nvim_buf_call(buf, function()
        vim.bo[buf].undolevels = -1
        local restore_positions = replace(buf, snapshot.content, content, is_empty, prepared)
        vim.bo[buf].undolevels = snapshot.options.undolevels
        if #history.nodes > 1 then command('rundo', candidate) end
        if not vim.deep_equal(vim.fn.undotree(), tree) or text(buf) ~= content or empty(buf) ~= is_empty then
          fail('HISTORY_INSTALL_FAILED', 'Native undo import did not match the prepared history')
        end
        vim.bo[buf].modified = modified
        restore_positions()
      end)
    end)
    if not installed then
      local restored, restore_error = pcall(function()
        vim.api.nvim_buf_call(buf, function()
          vim.bo[buf].undolevels = -1
          replace(buf, text(buf), snapshot.content, snapshot.empty)
          vim.bo[buf].undolevels = snapshot.options.undolevels
          if #snapshot.history.nodes > 1 then command('rundo', snapshot.original) end
          vim.bo[buf].modified = snapshot.modified
          restore_view(buf, original_view)
          if
            text(buf) ~= snapshot.content
            or empty(buf) ~= snapshot.empty
            or not vim.deep_equal(vim.fn.undotree(), snapshot.tree)
          then
            fail('HISTORY_RECOVERY_REQUIRED', 'Native history rollback did not restore the captured state')
          end
        end)
      end)
      if not restored then
        snapshot.keep = true
        fail('HISTORY_RECOVERY_REQUIRED', tostring(restore_error) .. '; recovery files: ' .. snapshot.directory)
      end
      error(install_error, 0)
    end
  end)
  if verification then vim.api.nvim_buf_delete(verification, { force = true }) end
  vim.api.nvim_buf_delete(shadow, { force = true })
  if not ok then error(err, 0) end
  return sequences
end

--- Rebase an independently saved archive in private buffers. The published
--- native bytes include completed save metadata absent from the pre-save
--- checkpoint; verify their text tree before preserving that native metadata.
function M.rebase_saved(checkpoint, encoded, rebased, raw)
  local current
  for _, node in ipairs(checkpoint.history.nodes) do
    if node.seq == checkpoint.history.current then current = node end
  end
  if not current then fail('INVALID_HISTORY', 'Saved history has no current state') end
  local shadow = scratch(current.content, current.empty)
  local captures = {}
  local function capture()
    local result = M.capture(shadow)
    captures[#captures + 1] = result
    return result
  end
  local ok, result = pcall(function()
    for _, name in ipairs(option_names) do
      vim.bo[shadow][name] = checkpoint.options[name]
    end
    local initial = capture()
    if #checkpoint.history.nodes > 1 then
      if type(encoded) ~= 'string' or #encoded > 4 * math.ceil(64 * 1024 * 1024 / 3) then
        fail('HISTORY_HELD', 'Saved native history is missing or exceeds the metadata limit')
      end
      local decoded, bytes = pcall(vim.base64.decode, encoded)
      if not decoded or vim.base64.encode(bytes) ~= encoded then fail('HISTORY_HELD', 'Invalid saved undo encoding') end
      require('overleaf.editor.undofile').saved(bytes, false)
      if current.empty then bytes = require('overleaf.editor.undofile').empty_readback(bytes, false) end
      local filename = initial.directory .. '/published.undo'
      write_undo(filename, bytes)
      vim.api.nvim_buf_call(shadow, function() command('rundo', filename) end)
    elseif encoded ~= vim.NIL and encoded ~= nil then
      fail('HISTORY_HELD', 'Unexpected history for a saved undo root')
    end
    local original = capture()
    if not vim.deep_equal(original.history, checkpoint.history) then
      fail('HISTORY_HELD', 'Persistent native history differs from its saved checkpoint')
    end
    M.install(original, rebased, false)
    local installed = capture()
    if not raw then return M.saved_artifact(installed, false) end
    local bytes = M.saved_undo(installed, false)
    return { checkpoint = M.checkpoint(installed), bytes = bytes and vim.base64.encode(bytes) or vim.NIL }
  end)
  vim.api.nvim_buf_delete(shadow, { force = true })
  for _, snapshot in ipairs(captures) do
    -- These are private verification buffers; the durable archive remains in
    -- the workspace even if native import or rollback failed here.
    snapshot.keep = false
    M.dispose(snapshot)
  end
  if not ok then error(result, 0) end
  return result
end

--- Prepare the saved state for native file readback. Neovim consumes a final
--- separator as endofline when reopening; a noeol final empty line must therefore
--- be represented by that option rather than another line in the undo hash.
--- Other states retain their native lines: like ordinary persistent undo,
--- newline options belong to the reopened buffer, not individual undo entries.
function M.saved_artifact(snapshot, advance)
  local bytes, tree = M.saved_undo(snapshot, advance)
  local encoded = bytes and vim.base64.encode(bytes) or vim.NIL
  local checkpoint = {
    history = vim.deepcopy(snapshot.history),
    tree = tree or vim.deepcopy(snapshot.tree),
    options = vim.deepcopy(snapshot.options),
    undo = encoded,
  }
  local rebased = vim.deepcopy(checkpoint.history)
  local current
  for _, node in ipairs(rebased.nodes) do
    if node.seq == rebased.current then current = node end
  end
  local eol = checkpoint.options.endofline
  if not eol and not checkpoint.options.fixendofline then
    if current.content:sub(-1) == '\n' then
      current.content = current.content:sub(1, -2)
      eol = true
    elseif current.content == '' then
      current.empty = true
    end
  end
  if not vim.deep_equal(rebased, checkpoint.history) then
    local artifact = M.rebase_saved(checkpoint, encoded, rebased, true)
    checkpoint, encoded = artifact.checkpoint, artifact.bytes
    checkpoint.options.endofline = eol
  end
  if current.empty and encoded ~= vim.NIL then
    encoded = vim.base64.encode(require('overleaf.editor.undofile').empty_readback(vim.base64.decode(encoded), true))
  end
  return { checkpoint = checkpoint, bytes = encoded }
end

--- Restore a reviewed archived graph, retaining the current capture for rollback.
--- Native reopening normalizes save_cur to save_last; all text states, branches,
--- sequence IDs, timestamps and saved markers are verified before live import.
function M.restore(snapshot, checkpoint, modified)
  check(snapshot)
  if type(modified) ~= 'boolean' then fail('INVALID_HISTORY', 'Disk modified state must be explicit') end
  if snapshot.tree.save_cur ~= snapshot.tree.save_last then
    fail('HISTORY_HELD', 'Save the current undo position before restoring another history')
  end
  local prepared = M.rebase_saved(checkpoint, checkpoint.undo, checkpoint.history, true).checkpoint
  local expected = vim.deepcopy(checkpoint.tree)
  expected.save_cur = expected.save_last
  if not vim.deep_equal(prepared.tree, expected) then
    fail('HISTORY_HELD', 'Archived native metadata differs from its checkpoint')
  end
  local current
  for _, node in ipairs(prepared.history.nodes) do
    if node.seq == prepared.history.current then current = node end
  end
  local candidate = snapshot.directory .. '/recovery.undo'
  if prepared.undo ~= vim.NIL then write_undo(candidate, vim.base64.decode(prepared.undo)) end
  check(snapshot)
  local buf = snapshot.bufnr
  local function import(content, is_empty, opts, tree, filename, has_undo, changed)
    vim.api.nvim_buf_call(buf, function()
      vim.bo[buf].undolevels = -1
      set(buf, content, is_empty)
      for _, name in ipairs(option_names) do
        vim.bo[buf][name] = opts[name]
      end
      if has_undo then command('rundo', filename) end
      if text(buf) ~= content or empty(buf) ~= is_empty or not vim.deep_equal(vim.fn.undotree(), tree) then
        fail('HISTORY_HELD', 'Restored native history differs from the reviewed checkpoint')
      end
      vim.bo[buf].modified = changed
    end)
  end
  local ok, err = pcall(
    import,
    current.content,
    current.empty,
    prepared.options,
    prepared.tree,
    candidate,
    prepared.undo ~= vim.NIL,
    modified
  )
  if not ok then
    local restored, restore_error = pcall(
      import,
      snapshot.content,
      snapshot.empty,
      snapshot.options,
      snapshot.tree,
      snapshot.original,
      #snapshot.history.nodes > 1,
      snapshot.modified
    )
    if not restored then
      snapshot.keep = true
      fail('HISTORY_RECOVERY_REQUIRED', tostring(restore_error) .. '; recovery files: ' .. snapshot.directory)
    end
    error(err, 0)
  end
end

function M.dispose(snapshot)
  if snapshot.disposed or snapshot.keep then return end
  vim.fn.delete(snapshot.directory, 'rf')
  snapshot.disposed = true
end

return M
