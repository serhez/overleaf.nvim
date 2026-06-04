local config = require('overleaf.config')
local overleaf = require('overleaf')

describe('overleaf context detection', function()
  local original_config

  before_each(function()
    original_config = vim.deepcopy(config._config)
    config.setup({ sync_dir = '/tmp/overleaf.nvim-context-test' })
  end)

  after_each(function()
    config._config = original_config

    for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(bufnr) and vim.b[bufnr].overleaf_context_test then
        pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
      end
    end
  end)

  it('detects live Overleaf URI buffers', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_context_test = true
    vim.api.nvim_buf_set_name(bufnr, 'overleaf://main.tex')

    assert.is_true(overleaf.is_overleaf_context(bufnr))
  end)

  it('detects files below the configured sync root', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_context_test = true
    vim.api.nvim_buf_set_name(bufnr, '/tmp/overleaf.nvim-context-test/Paper/main.tex')

    assert.is_true(overleaf.is_overleaf_context(bufnr))
  end)

  it('rejects regular local buffers', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_context_test = true
    vim.api.nvim_buf_set_name(bufnr, '/tmp/not-overleaf/main.tex')

    assert.is_false(overleaf.is_overleaf_context(bufnr))
  end)
end)
