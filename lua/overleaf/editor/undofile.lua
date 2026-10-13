local M = {}

local function hold(message) error('HISTORY_HELD: ' .. message, 0) end

-- Neovim's version-3 format (src/nvim/undo.c) stores metadata separately from
-- text entries. Extmark records contain native structs; only the verified
-- 64-bit layout is supported. Unknown layouts hold updates before live import.
local function parse(data)
  local version = vim.version()
  if version.major ~= 0 or version.minor < 10 or version.minor > 12 or not require('ffi').abi('64bit') then
    hold('Unsupported native undo format')
  end
  if type(data) ~= 'string' or #data > 64 * 1024 * 1024 then hold('Undo file exceeds the metadata limit') end
  local pos = 1
  local function skip(size)
    local at = pos
    if size < 0 or size > #data - pos + 1 then hold('Incomplete undo file') end
    pos = pos + size
    return at
  end
  local function number(size)
    local at, value = skip(size), 0
    for i = at, at + size - 1 do
      value = value * 256 + data:byte(i)
    end
    return value, at
  end
  local function field()
    local value, at = number(4)
    return { value = value, at = at }
  end
  local function options()
    local save
    while true do
      local length = number(1)
      if length == 0 then break end
      if number(1) ~= 1 or length ~= 4 or save then hold('Unknown undo metadata field') end
      save = field()
    end
    if not save then hold('Missing undo save metadata') end
    return save
  end
  if data:sub(skip(9), 9) ~= 'Vim\159UnDo\229' or number(2) ~= 3 then hold('Unsupported undo file header') end
  skip(32 + 4) -- content hash and line count belong to the candidate text
  skip(number(4)) -- saved line for native U
  skip(8)
  local result = { links = { field(), field(), field() }, nodes = {} }
  local count = number(4)
  if count > 999 then hold('Too many native undo headers') end
  result.last, result.current = field(), field()
  result.time, result.save = skip(8), options()
  for _ = 1, count do
    if number(2) ~= 0x5fd0 then hold('Invalid undo header') end
    local node = { links = { field(), field(), field(), field() }, seq = field() }
    if node.seq.value == 0 or result.nodes[node.seq.value] then hold('Duplicate native undo sequence') end
    result.nodes[node.seq.value] = node
    node.cursor = { field(), field(), field(), field() } -- line, byte column, column add, virtual column
    local flags, at = number(2)
    node.flags = { value = flags, at = at }
    skip(26 * 12 + 32) -- named marks and visual selection
    node.time, node.save = skip(8), options()
    local marker = number(2)
    while marker == 0xf518 do
      skip(12) -- text-entry coordinates
      local lines = number(4)
      for _ = 1, lines do
        skip(number(4))
      end
      marker = number(2)
    end
    if marker ~= 0x3581 then hold('Invalid undo text entry') end
    marker = number(2)
    while marker == 0xf518 do
      local kind = number(4)
      if kind ~= 0 and kind ~= 1 then hold('Unknown undo extmark record') end
      skip(48) -- six 32-bit coordinates and three 64-bit byte counts
      marker = number(2)
    end
    if marker ~= 0x3581 then hold('Invalid undo extmark entry') end
  end
  if number(2) ~= 0xe7aa or pos ~= #data + 1 then hold('Invalid undo file end') end
  local function check(reference)
    if reference.value ~= 0 and not result.nodes[reference.value] then hold('Dangling undo sequence') end
  end
  check(result.current)
  for _, link in ipairs(result.links) do
    check(link)
  end
  for _, node in pairs(result.nodes) do
    for _, link in ipairs(node.links) do
      check(link)
    end
  end
  return result
end

local function apply(data, patches)
  table.sort(patches, function(a, b) return a.at < b.at end)
  local pieces, pos = {}, 1
  for _, patch in ipairs(patches) do
    pieces[#pieces + 1] = data:sub(pos, patch.at - 1)
    pieces[#pieces + 1] = patch.value
    pos = patch.at + patch.size
  end
  pieces[#pieces + 1] = data:sub(pos)
  return table.concat(pieces)
end

local function integer(value)
  if value < 0 or value > 4294967295 or value ~= math.floor(value) then hold('Invalid native cursor coordinate') end
  return string.char(
    math.floor(value / 16777216) % 256,
    math.floor(value / 65536) % 256,
    math.floor(value / 256) % 256,
    value % 256
  )
end

local function save_patches(parsed, sequence)
  if sequence ~= 0 and not parsed.nodes[sequence] then hold('Saved undo sequence is missing') end
  if parsed.save.value >= 2147483647 then hold('Native save counter is exhausted') end
  local count = parsed.save.value + 1
  local value = string.char(
    math.floor(count / 16777216) % 256,
    math.floor(count / 65536) % 256,
    math.floor(count / 256) % 256,
    count % 256
  )
  local patches = { { at = parsed.save.at, size = 4, value = value } }
  -- Native writes at the undo root advance the counter without a header marker.
  if sequence ~= 0 then patches[#patches + 1] = { at = parsed.nodes[sequence].save.at, size = 4, value = value } end
  return patches
end

--- Record one confirmed write at a captured native sequence. All other bytes,
--- including text, positions, timestamps, and branch links, remain unchanged.
function M.record_save(data, sequence) return apply(data, save_patches(parse(data), sequence)) end

--- Prepare a frozen tree for reopening the saved text. This mirrors native
--- u_unchanged/u_update_save_nr; it must not be imported into a newer live buffer.
function M.saved(data, advance)
  local parsed = parse(data)
  if not advance then return data end
  local patches = save_patches(parsed, parsed.current.value)
  for _, node in pairs(parsed.nodes) do
    -- UH_CHANGED (0x01) makes undoing any saved state mark the buffer dirty.
    local flags = bit.bor(node.flags.value, 1)
    patches[#patches + 1] = { at = node.flags.at, size = 2, value = string.char(math.floor(flags / 256), flags % 256) }
  end
  return apply(data, patches)
end

--- Native file reading hashes zero lines for an empty file, while :rundo hashes
--- the buffer's one empty sentinel line. Translate only this verified case.
function M.empty_readback(data, for_readback)
  parse(data)
  local function binary(hex)
    return (hex:gsub('..', function(byte) return string.char(tonumber(byte, 16)) end))
  end
  local file_hash = binary('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  local buffer_hash = binary('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d')
  local hash = data:sub(12, 43)
  if (hash ~= file_hash and hash ~= buffer_hash) or data:sub(44, 47) ~= '\0\0\0\1' then
    hold('Empty undo readback requires a matching empty native state')
  end
  return data:sub(1, 11) .. (for_readback and file_hash or buffer_hash) .. data:sub(44)
end

--- Restore IDs, timestamps, save markers, and historical edit cursors.
--- map_cursor maps a header's pre-edit position into its rebased parent text.
--- Text, hash, flag, and extmark bytes remain those of the candidate.
--- This pure operation never modifies the original recovery file.
function M.restore(original, candidate, sequences, map_cursor)
  local source, target = parse(original), parse(candidate)
  local reverse, patches = { [0] = 0 }, {}
  for old, new in pairs(sequences) do
    if old ~= 0 then
      if not source.nodes[old] or not target.nodes[new] or reverse[new] then hold('Invalid undo sequence mapping') end
      reverse[new] = old
    elseif new ~= 0 then
      hold('Invalid undo root mapping')
    end
  end
  local function copy(from, to, size)
    patches[#patches + 1] = { at = to, size = size, value = original:sub(from, from + size - 1) }
  end
  local function links(from, to)
    for i, link in ipairs(from) do
      if link.value ~= reverse[to[i].value] then hold('Native undo branches could not be restored exactly') end
      copy(link.at, to[i].at, 4)
    end
  end
  links(source.links, target.links)
  links({ source.current }, { target.current })
  copy(source.last.at, target.last.at, 4)
  copy(source.time, target.time, 8)
  copy(source.save.at, target.save.at, 4)
  for seq, node in pairs(target.nodes) do
    local previous = source.nodes[reverse[seq]]
    if not previous then hold('Missing native undo sequence mapping') end
    links(previous.links, node.links)
    copy(previous.seq.at, node.seq.at, 4)
    copy(previous.time, node.time, 8)
    copy(previous.save.at, node.save.at, 4)
    local line, col = previous.cursor[1].value, previous.cursor[2].value
    local virtual = previous.cursor[4].value
    if map_cursor and line > 0 then
      local row, column, shift = map_cursor(reverse[seq], line - 1, col)
      line, col = row + 1, column
      if virtual ~= 4294967295 then virtual = math.max(0, virtual + (shift or 0)) end
    end
    patches[#patches + 1] = {
      at = node.cursor[1].at,
      size = 16,
      value = integer(line) .. integer(col) .. integer(previous.cursor[3].value) .. integer(virtual),
    }
  end
  for seq in pairs(source.nodes) do
    if not sequences[seq] then hold('Missing original undo sequence') end
  end
  return apply(candidate, patches)
end

return M
