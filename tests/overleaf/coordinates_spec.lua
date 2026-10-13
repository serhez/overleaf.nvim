local coordinates = require('overleaf.coordinates')

describe('coordinates', function()
  describe('utf8_len', function()
    it('counts ASCII characters', function() assert.are.equal(5, coordinates.utf8_len('hello')) end)

    it('counts empty string', function() assert.are.equal(0, coordinates.utf8_len('')) end)

    it('counts 2-byte characters', function()
      -- café: c(1) a(1) f(1) é(2 bytes) = 4 chars
      assert.are.equal(4, coordinates.utf8_len('café'))
    end)

    it('counts 3-byte characters (CJK)', function()
      -- 日本語: 3 chars, each 3 bytes
      assert.are.equal(3, coordinates.utf8_len('日本語'))
    end)

    it('counts 4-byte characters (emoji)', function() assert.are.equal(1, coordinates.utf8_len('😀')) end)

    it('counts mixed ASCII and multibyte', function()
      -- "a日b" = 3 chars
      assert.are.equal(3, coordinates.utf8_len('a日b'))
    end)
  end)

  describe('byte_to_char', function()
    it('returns 0 for offset 0', function() assert.are.equal(0, coordinates.byte_to_char('hello', 0)) end)

    it('handles ASCII correctly', function() assert.are.equal(3, coordinates.byte_to_char('hello', 3)) end)

    it('converts byte offset in multibyte string', function()
      -- "café": c(1) a(2) f(3) é(4,5) -> byte 3 = char 3
      assert.are.equal(3, coordinates.byte_to_char('café', 3))
    end)

    it('converts byte offset past multibyte char', function()
      -- "café": é starts at byte 4, ends at byte 5 -> byte 5 = char 4
      assert.are.equal(4, coordinates.byte_to_char('café', 5))
    end)

    it('handles CJK characters', function()
      -- "日本語": 日(1-3) 本(4-6) 語(7-9)
      -- byte_offset=3 -> char 1, byte_offset=6 -> char 2
      assert.are.equal(1, coordinates.byte_to_char('日本語', 3))
      assert.are.equal(2, coordinates.byte_to_char('日本語', 6))
    end)
  end)

  describe('char_to_byte', function()
    it('returns 0 for offset 0', function() assert.are.equal(0, coordinates.char_to_byte('hello', 0)) end)

    it('handles ASCII correctly', function() assert.are.equal(3, coordinates.char_to_byte('hello', 3)) end)

    it('converts char offset in multibyte string', function()
      -- "café": char 3 (f) = byte 3
      assert.are.equal(3, coordinates.char_to_byte('café', 3))
    end)

    it('converts char offset past multibyte char', function()
      -- "café": char 4 (end) = byte 5
      assert.are.equal(5, coordinates.char_to_byte('café', 4))
    end)

    it('handles CJK characters', function()
      -- "日本語": char 1 = byte 3, char 2 = byte 6
      assert.are.equal(3, coordinates.char_to_byte('日本語', 1))
      assert.are.equal(6, coordinates.char_to_byte('日本語', 2))
    end)

    it('roundtrips with byte_to_char', function()
      local s = 'hello日本語world'
      for i = 0, coordinates.utf8_len(s) do
        local b = coordinates.char_to_byte(s, i)
        local c = coordinates.byte_to_char(s, b)
        assert.are.equal(i, c, 'roundtrip failed at char ' .. i)
      end
    end)
  end)

  describe('byte_offset_to_pos', function()
    it('returns (0,0) for offset 0', function()
      local row, col = coordinates.byte_offset_to_pos('hello\nworld', 0)
      assert.are.equal(0, row)
      assert.are.equal(0, col)
    end)

    it('returns correct position on second line', function()
      -- "hello\nworld" -> offset 6 = 'w' on line 1, col 0
      local row, col = coordinates.byte_offset_to_pos('hello\nworld', 6)
      assert.are.equal(1, row)
      assert.are.equal(0, col)
    end)

    it('roundtrips with pos_to_byte_offset', function()
      local content = 'line one\nline two\nline three'
      for offset = 0, #content - 1 do
        local row, col = coordinates.byte_offset_to_pos(content, offset)
        local back = coordinates.pos_to_byte_offset(content, row, col)
        assert.are.equal(offset, back, 'roundtrip failed at offset ' .. offset)
      end
    end)
  end)
end)
