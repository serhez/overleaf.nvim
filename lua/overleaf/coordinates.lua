--- UTF-8 position conversion for cached comment views. Live OT belongs to Node.

local M = {}

--- Count UTF-8 characters in a string
---@param s string UTF-8 encoded string
---@return number character count
function M.utf8_len(s)
  local len = 0
  local i = 1
  local n = #s
  while i <= n do
    local byte = s:byte(i)
    if byte < 0x80 then
      i = i + 1
    elseif byte < 0xE0 then
      i = i + 2
    elseif byte < 0xF0 then
      i = i + 3
    else
      i = i + 4
    end
    len = len + 1
  end
  return len
end

--- Convert 0-based byte offset to 0-based character offset
---@param s string UTF-8 encoded string
---@param byte_offset number 0-based byte offset
---@return number character offset (0-based)
function M.byte_to_char(s, byte_offset)
  if byte_offset <= 0 then return 0 end
  local chars = 0
  local i = 1
  while i <= byte_offset and i <= #s do
    local byte = s:byte(i)
    if byte < 0x80 then
      i = i + 1
    elseif byte < 0xE0 then
      i = i + 2
    elseif byte < 0xF0 then
      i = i + 3
    else
      i = i + 4
    end
    chars = chars + 1
  end
  return chars
end

--- Convert 0-based character offset to 0-based byte offset
---@param s string UTF-8 encoded string
---@param char_offset number 0-based character offset
---@return number byte offset (0-based)
function M.char_to_byte(s, char_offset)
  if char_offset <= 0 then return 0 end
  local i = 1
  local n = #s
  local chars = 0
  while i <= n and chars < char_offset do
    local byte = s:byte(i)
    if byte < 0x80 then
      i = i + 1
    elseif byte < 0xE0 then
      i = i + 2
    elseif byte < 0xF0 then
      i = i + 3
    else
      i = i + 4
    end
    chars = chars + 1
  end
  return i - 1
end

--- Convert byte offset to (0-indexed row, col) in content string
---@param content string
---@param byte_offset number 0-based byte offset
---@return number row (0-indexed)
---@return number col (0-indexed)
function M.byte_offset_to_pos(content, byte_offset)
  local row = 0
  local last_newline = 0 -- position after last newline (1-indexed in content)

  for i = 1, byte_offset do
    if content:byte(i) == 10 then -- '\n'
      row = row + 1
      last_newline = i
    end
  end

  local col = byte_offset - last_newline
  return row, col
end

--- Convert (0-indexed row, col) to byte offset in content string
---@param content string
---@param row number 0-indexed
---@param col number 0-indexed
---@return number byte offset (0-based)
function M.pos_to_byte_offset(content, row, col)
  local current_row = 0
  local offset = 0

  for i = 1, #content do
    if current_row == row then return offset + col end
    if content:byte(i) == 10 then current_row = current_row + 1 end
    offset = offset + 1
  end

  -- Past end of content, return at the requested position
  return offset + col
end

return M
