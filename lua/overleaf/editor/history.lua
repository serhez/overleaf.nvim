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

local function replace(buf, before, after, is_empty)
  if is_empty then
    set(buf, after, true)
    return
  end
  local lines = vim.split(after, '\n', { plain = true })
  local changes = vim.diff(before .. '\n', after .. '\n', { result_type = 'indices' })
  -- Apply from the end so earlier coordinates remain valid. Unchanged lines,
  -- cursors, and extmarks retain their native positions instead of being replaced.
  for i = #changes, 1, -1 do
    local change = changes[i]
    local start = change[2] == 0 and change[1] or change[1] - 1
    local replacement = {}
    for row = change[3], change[3] + change[4] - 1 do
      replacement[#replacement + 1] = lines[row]
    end
    vim.api.nvim_buf_set_lines(buf, start, start + change[2], false, replacement)
  end
  if #changes == 0 then set(buf, after) end
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
function M.capture(buf)
  if not vim.api.nvim_buf_is_loaded(buf) then fail('STALE_BUFFER', 'Buffer is not loaded') end
  if vim.bo[buf].binary then fail('INVALID_HISTORY', 'Binary buffers cannot be rebased') end
  -- Finish the current local undo unit before exporting it. :wundo also syncs
  -- native history; subsequent typing must not join a unit being rebased.
  vim.bo[buf].undolevels = vim.bo[buf].undolevels
  local snapshot = {
    bufnr = buf,
    content = text(buf),
    empty = empty(buf),
    changedtick = vim.api.nvim_buf_get_changedtick(buf),
    options = options(buf),
    modified = vim.bo[buf].modified,
    directory = assert(uv.fs_mkdtemp(uv.os_tmpdir() .. '/overleaf-history-XXXXXX')),
  }
  local shadow
  local ok, err = pcall(function()
    snapshot.tree = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    local nodes = { { seq = 0, parent = vim.NIL } }
    local function visit(entries, parent)
      for _, entry in ipairs(entries) do
        if entry.alt then visit(entry.alt, parent) end
        nodes[#nodes + 1] = { seq = entry.seq, parent = parent }
        if #nodes > MAX_NODES then fail('HISTORY_LIMIT', 'Undo history exceeds the automatic rebase limit') end
        parent = entry.seq
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
    snapshot.original = snapshot.directory .. '/original.undo'
    if #nodes > 1 then vim.api.nvim_buf_call(buf, function() command('wundo', snapshot.original) end) end
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
      content = snapshot.content,
      empty = snapshot.empty,
      options = snapshot.options,
      history = snapshot.history,
    })
    if vim.fn.writefile({ backup }, snapshot.directory .. '/snapshot.json', 'b') ~= 0 then
      fail('HISTORY_CAPTURE_FAILED', 'Could not preserve the original buffer snapshot')
    end
  end)
  if shadow then vim.api.nvim_buf_delete(shadow, { force = true }) end
  if not ok then
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
      local candidate_bytes =
        require('overleaf.editor.undofile').restore(read_undo(snapshot.original), read_undo(candidate), sequences)
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
    local installed, install_error = pcall(function()
      vim.api.nvim_buf_call(buf, function()
        vim.bo[buf].undolevels = -1
        replace(buf, snapshot.content, content, is_empty)
        vim.bo[buf].undolevels = snapshot.options.undolevels
        if #history.nodes > 1 then command('rundo', candidate) end
        if not vim.deep_equal(vim.fn.undotree(), tree) or text(buf) ~= content or empty(buf) ~= is_empty then
          fail('HISTORY_INSTALL_FAILED', 'Native undo import did not match the prepared history')
        end
        vim.bo[buf].modified = modified
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

function M.dispose(snapshot)
  if snapshot.disposed or snapshot.keep then return end
  vim.fn.delete(snapshot.directory, 'rf')
  snapshot.disposed = true
end

return M
