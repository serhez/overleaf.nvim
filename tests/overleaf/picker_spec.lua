local config = require('overleaf.config')
local picker = require('overleaf.picker')

describe('picker', function()
  local original_config
  local original_select
  local original_open_location

  before_each(function()
    original_config = vim.deepcopy(config._config)
    original_select = vim.ui.select
    original_open_location = require('overleaf').open_location
    config.setup({ picker = 'native' })
  end)

  after_each(function()
    config._config = original_config
    vim.ui.select = original_select
    require('overleaf').open_location = original_open_location
    pcall(vim.cmd, 'cclose')
    for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_get_name(bufnr):match('^overleaf://') then
        vim.api.nvim_buf_delete(bufnr, { force = true })
      end
      if vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_get_name(bufnr):match('^overleaf%-qf://') then
        vim.api.nvim_buf_delete(bufnr, { force = true })
      end
    end
  end)

  it('falls back to vim.ui.select for native selections', function()
    local selected
    local items = {
      { label = 'One', id = '1' },
      { label = 'Two', id = '2' },
    }

    vim.ui.select = function(select_items, opts, callback)
      assert.are.same(items, select_items)
      assert.are.equal('Pick:', opts.prompt)
      assert.are.equal('Two', opts.format_item(items[2]))
      callback(items[2])
    end

    picker.select(items, {
      prompt = 'Pick:',
      format_item = function(item) return item.label end,
    }, function(choice) selected = choice end)

    assert.are.same(items[2], selected)
  end)

  it('builds quickfix items with Overleaf user data', function()
    local locations = {
      {
        doc_id = 'doc-1',
        path = 'main.tex',
        lnum = 3,
        col = 5,
        text = 'hello world',
      },
    }

    local items = picker._qf_items(locations)

    assert.are.equal(1, #items)
    assert.are.equal('overleaf://main.tex', items[1].filename)
    assert.are.equal(3, items[1].lnum)
    assert.are.equal(5, items[1].col)
    assert.are.equal('hello world', items[1].text)
    assert.are.same(locations[1], items[1].user_data)
    assert.are.equal(1, items[1].valid)
    assert.is_number(items[1].bufnr)

    local bufnr = items[1].bufnr

    assert.is_true(vim.api.nvim_buf_is_valid(bufnr))
    assert.are.equal('overleaf://main.tex', vim.api.nvim_buf_get_name(bufnr))
    assert.are.equal(3, vim.api.nvim_buf_line_count(bufnr))
  end)

  it('resolves placeholder buffers to the clicked Overleaf location', function()
    local locations = {
      {
        doc_id = 'doc-1',
        path = 'main.tex',
        lnum = 3,
        col = 5,
        text = 'first match',
      },
      {
        doc_id = 'doc-1',
        path = 'main.tex',
        lnum = 7,
        col = 2,
        text = 'second match',
      },
    }

    local items = picker._qf_items(locations)
    local bufnr = items[1].bufnr
    local location = picker._resolve_placeholder_location(bufnr, 7, 2)

    assert.are.equal('doc-1', location.doc_id)
    assert.are.equal('main.tex', location.path)
    assert.are.equal(7, location.lnum)
    assert.are.equal(2, location.col)
    assert.are.equal('second match', location.text)
    assert.are.equal(bufnr, location.bufnr)
  end)

  it('uses a launcher buffer when an existing Overleaf buffer is too short for qf targets', function()
    local stale = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_name(stale, 'overleaf://main.tex')
    vim.api.nvim_buf_set_lines(stale, 0, -1, false, { 'only one line' })

    local items = picker._qf_items({
      {
        doc_id = 'doc-1',
        path = 'main.tex',
        lnum = 8,
        col = 1,
        text = 'target',
      },
    })

    assert.is_number(items[1].bufnr)
    assert.are_not.equal(stale, items[1].bufnr)
    assert.matches('^overleaf%-qf://', vim.api.nvim_buf_get_name(items[1].bufnr))
    assert.are.equal(8, vim.api.nvim_buf_line_count(items[1].bufnr))
  end)

  it('opens Overleaf locations from repeated qf buffer jumps', function()
    local opened = {}
    require('overleaf').open_location = function(location) opened[#opened + 1] = vim.deepcopy(location) end

    local locations = {
      {
        doc_id = 'doc-1',
        path = 'main.tex',
        lnum = 3,
        col = 5,
        text = 'first match',
      },
      {
        doc_id = 'doc-1',
        path = 'main.tex',
        lnum = 7,
        col = 2,
        text = 'second match',
      },
    }

    vim.fn.setqflist({}, 'r', { items = picker._qf_items(locations) })
    local items = vim.fn.getqflist()
    local bufnr = items[2].bufnr

    vim.fn.bufload(bufnr)
    vim.api.nvim_win_set_buf(0, bufnr)
    vim.api.nvim_win_set_cursor(0, { 7, 1 })

    vim.wait(100, function() return #opened == 1 end)
    assert.are.equal(1, #opened)
    assert.are.equal('main.tex', opened[1].path)
    assert.are.equal(7, opened[1].lnum)
    assert.are.equal(2, opened[1].col)
    assert.is_nil(opened[1].bufnr)

    local scratch = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_win_set_buf(0, scratch)
    vim.wait(300, function() return false end)

    vim.api.nvim_win_set_buf(0, bufnr)
    vim.api.nvim_win_set_cursor(0, { 3, 4 })

    vim.wait(100, function() return #opened == 2 end)
    assert.are.equal(2, #opened)
    assert.are.equal('main.tex', opened[2].path)
    assert.are.equal(3, opened[2].lnum)
    assert.are.equal(5, opened[2].col)
    assert.is_nil(opened[2].bufnr)
  end)

  it('builds live document picker items from project docs only', function()
    local entries = {
      { type = 'folder', path = 'sections/', id = 'folder-1' },
      { type = 'doc', path = 'main.tex', id = 'doc-1' },
      { type = 'doc', path = 'sections/intro.tex', id = 'doc-2' },
      { type = 'file', path = 'figure.pdf', id = 'file-1' },
    }

    local items = picker._document_items(entries, 'intro')

    assert.are.equal(1, #items)
    assert.are.equal('sections/intro.tex', items[1].text)
    assert.are.same(entries[3], items[1].item)
  end)

  it('converts picker items back to Overleaf locations', function()
    local entry = {
      doc_id = 'doc-1',
      path = 'main.tex',
      lnum = 4,
      col = 2,
      text = 'match',
    }

    local locations = picker._picker_items_to_locations({
      {
        item = entry,
        text = 'main.tex:4:2 match',
      },
    })

    assert.are.equal(1, #locations)
    assert.are.equal('doc-1', locations[1].doc_id)
    assert.are.equal('main.tex', locations[1].path)
    assert.are.equal(4, locations[1].lnum)
    assert.are.equal(2, locations[1].col)
    assert.are.equal('match', locations[1].text)
  end)
end)
