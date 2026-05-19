local config = require('overleaf.config')

describe('config', function()
  -- Save original config and restore after each test
  local original_config

  before_each(function() original_config = vim.deepcopy(config._config) end)

  after_each(function() config._config = original_config end)

  describe('defaults', function()
    it(
      'has base_url defaulting to overleaf.com',
      function() assert.are.equal('https://www.overleaf.com', config.get().base_url) end
    )

    it('has pdf_viewer defaulting to nil', function() assert.is_nil(config.get().pdf_viewer) end)

    it('has node_path defaulting to node', function() assert.are.equal('node', config.get().node_path) end)

    it('has log_level defaulting to info', function() assert.are.equal('info', config.get().log_level) end)

    it('has explorer defaulting to native', function() assert.are.equal('native', config.get().explorer) end)

    it('uses Overleaf compile backend by default', function()
      assert.are.equal('overleaf', config.get().compile.backend)
      assert.is_true(config.get().compile.open_pdf)
    end)

    it(
      'cleans up virtual buffers on exit by default',
      function() assert.is_true(config.get().cleanup_buffers_on_exit) end
    )
  end)

  describe('setup', function()
    it('overrides base_url for self-hosted instance', function()
      config.setup({ base_url = 'https://my-overleaf.example.com' })
      assert.are.equal('https://my-overleaf.example.com', config.get().base_url)
    end)

    it('overrides pdf_viewer', function()
      config.setup({ pdf_viewer = 'zathura' })
      assert.are.equal('zathura', config.get().pdf_viewer)
    end)

    it('overrides explorer', function()
      config.setup({ explorer = 'canola' })
      assert.are.equal('canola', config.get().explorer)
    end)

    it('overrides cleanup_buffers_on_exit', function()
      config.setup({ cleanup_buffers_on_exit = false })
      assert.is_false(config.get().cleanup_buffers_on_exit)
    end)

    it('merges compile config without dropping defaults', function()
      config.setup({ compile = { backend = 'local', main_file = 'paper.tex' } })
      assert.are.equal('local', config.get().compile.backend)
      assert.are.equal('paper.tex', config.get().compile.main_file)
      assert.is_true(config.get().compile.open_pdf)
    end)

    it('preserves unset fields', function()
      config.setup({ base_url = 'http://localhost:8080' })
      assert.are.equal('node', config.get().node_path)
      assert.are.equal('info', config.get().log_level)
    end)

    it('handles nil opts gracefully', function()
      config.setup(nil)
      assert.are.equal('https://www.overleaf.com', config.get().base_url)
    end)
  end)
end)
