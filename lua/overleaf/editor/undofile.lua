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
    skip(12 + 4 + 2 + 26 * 12 + 32) -- cursor, flags, named marks, visual selection
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
  local function check(field)
    if field.value ~= 0 and not result.nodes[field.value] then hold('Dangling undo sequence') end
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

--- Restore IDs, timestamps, and save markers in a Neovim-generated candidate.
--- Text, hash, cursor, flag, and extmark bytes remain those of the candidate.
--- This pure operation never modifies the original recovery file.
function M.restore(original, candidate, sequences)
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
  end
  for seq in pairs(source.nodes) do
    if not sequences[seq] then hold('Missing original undo sequence') end
  end
  table.sort(patches, function(a, b) return a.at < b.at end)
  local pieces, pos = {}, 1
  for _, patch in ipairs(patches) do
    pieces[#pieces + 1] = candidate:sub(pos, patch.at - 1)
    pieces[#pieces + 1] = patch.value
    pos = patch.at + patch.size
  end
  pieces[#pieces + 1] = candidate:sub(pos)
  return table.concat(pieces)
end

return M
