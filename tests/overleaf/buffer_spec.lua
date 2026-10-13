local buffer = require('overleaf.buffer')
local config = require('overleaf.config')
local sync = require('overleaf.sync')

describe('buffer', function()
  it('ordinary LSP attachment does not synchronize sources or install global URI overrides', function()
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_name(buf, vim.fn.tempname() .. '.txt')
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'unsaved text' })
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    local before = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    local ops = require('overleaf.ops')
    local old_sync, old_dir = ops.sync_project, sync.dir
    local uri, sync_calls = vim.uri_from_bufnr, 0
    ops.sync_project = function() sync_calls = sync_calls + 1 end
    sync.dir = function() return '/tmp/overleaf-lsp-test' end
    local ok, failure = pcall(function()
      buffer._attach_lsp(buf, 'text')
      assert.are.equal(0, sync_calls)
      assert.are.equal(uri, vim.uri_from_bufnr)
      assert.are.same(before, vim.api.nvim_buf_call(buf, vim.fn.undotree))
      assert.is_true(vim.bo[buf].modified)
      assert.are.same({ 'unsaved text' }, vim.api.nvim_buf_get_lines(buf, 0, -1, false))
    end)
    ops.sync_project, sync.dir = old_sync, old_dir
    vim.api.nvim_buf_delete(buf, { force = true })
    assert.is_true(ok, tostring(failure))
  end)

  it('sets up ordinary-file tools once without changing text, history, options, or subscriptions', function()
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_name(buf, vim.fn.tempname() .. '.tex')
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'unsaved text' })
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
    vim.bo[buf].filetype = 'tex'
    local before = vim.api.nvim_buf_call(buf, vim.fn.undotree)
    local lsp, lint, ts = buffer._attach_lsp, buffer._run_chktex, vim.treesitter.start
    local calls = { lsp = 0, lint = 0, ts = 0 }
    buffer._attach_lsp = function(target, ft)
      assert.are.equal(buf, target)
      assert.are.equal('tex', ft)
      calls.lsp = calls.lsp + 1
    end
    buffer._run_chktex = function(target)
      assert.are.equal(buf, target)
      calls.lint = calls.lint + 1
    end
    vim.treesitter.start = function(target, lang)
      assert.are.equal(buf, target)
      assert.are.equal('latex', lang)
      calls.ts = calls.ts + 1
    end
    local ok, failure = pcall(function()
      buffer.setup_native(buf, function() return true end)
      buffer.setup_native(buf, function() return true end)
      assert.is_true(vim.wait(1000, function() return calls.lsp > 0 end))
      assert.are.same({ lsp = 1, lint = 1, ts = 1 }, calls)
      assert.are.same(before, vim.api.nvim_buf_call(buf, vim.fn.undotree))
      assert.are.equal('', vim.bo[buf].buftype)
      assert.are.equal('tex', vim.bo[buf].filetype)
      assert.is_true(vim.bo[buf].modified)
      assert.are.same({ 'unsaved text' }, vim.api.nvim_buf_get_lines(buf, 0, -1, false))
    end)
    buffer._attach_lsp, buffer._run_chktex, vim.treesitter.start = lsp, lint, ts
    vim.api.nvim_buf_delete(buf, { force = true })
    assert.is_true(ok, tostring(failure))
  end)

  it('cancels delayed tool attachment when the source no longer belongs to the workspace', function()
    local buf = vim.api.nvim_create_buf(true, false)
    vim.bo[buf].filetype = 'tex'
    local lsp, called = buffer._attach_lsp, false
    buffer._attach_lsp = function() called = true end
    local ok, failure = pcall(function()
      buffer.setup_native(buf, function() return false end)
      vim.wait(50, function() return false end)
      assert.is_false(called)
    end)
    buffer._attach_lsp = lsp
    vim.api.nvim_buf_delete(buf, { force = true })
    assert.is_true(ok, tostring(failure))
  end)

  it('rejects stale lint output after typing and after a newer lint request', function()
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'current text' })
    local executable, start, send, close = vim.fn.executable, vim.fn.jobstart, vim.fn.chansend, vim.fn.chanclose
    local jobs = {}
    vim.fn.executable = function() return 1 end
    vim.fn.jobstart = function(_, opts)
      jobs[#jobs + 1] = opts
      return #jobs
    end
    vim.fn.chansend, vim.fn.chanclose = function() end, function() end
    local function deliver(index, message)
      jobs[index].on_stdout(index, { '1:1:1:Warning:' .. message })
      jobs[index].on_exit(index, 0)
      vim.wait(20, function() return false end)
    end
    local ok, failure = pcall(function()
      buffer._run_chktex(buf)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'new text' })
      deliver(1, 'obsolete')
      local ns = vim.api.nvim_create_namespace('overleaf_chktex')
      assert.are.equal(0, #vim.diagnostic.get(buf, { namespace = ns }))
      buffer._run_chktex(buf)
      buffer._run_chktex(buf)
      deliver(3, 'current')
      deliver(2, 'obsolete')
      local diagnostics = vim.diagnostic.get(buf, { namespace = ns })
      assert.are.equal(1, #diagnostics)
      assert.are.equal('current', diagnostics[1].message)
    end)
    vim.fn.executable, vim.fn.jobstart, vim.fn.chansend, vim.fn.chanclose = executable, start, send, close
    vim.api.nvim_buf_delete(buf, { force = true })
    assert.is_true(ok, tostring(failure))
  end)

  describe('LSP configuration', function()
    local old_sync_dir
    local old_lsp_config

    before_each(function()
      sync.stop()
      old_sync_dir = config.get().sync_dir
      old_lsp_config = vim.lsp.config
      vim.lsp.config = vim.deepcopy(vim.lsp.config or {})
    end)

    after_each(function()
      sync.stop()
      config.get().sync_dir = old_sync_dir
      vim.lsp.config = old_lsp_config
    end)

    it('uses the active sync directory as the LSP root', function()
      sync._sync_dir = '/tmp/overleaf.nvim-lsp-test/project-id'

      assert.are.equal('/tmp/overleaf.nvim-lsp-test/project-id', buffer._lsp_root_dir())
    end)

    it(
      'falls back to cwd when file sync is not active',
      function() assert.are.equal(vim.fn.getcwd(), buffer._lsp_root_dir()) end
    )

    it('builds texlab config with the synced project as workspace root', function()
      local root = '/tmp/overleaf.nvim-lsp-test/Paper'
      local srv = {
        name = 'texlab',
        cmd = { 'texlab' },
        settings = { texlab = { build = { onSave = false } } },
      }

      local lsp_config = buffer._lsp_server_config(srv, root, { tex = 'latex' })

      assert.are.equal('texlab', lsp_config.name)
      assert.are.equal(root, lsp_config.root_dir)
      assert.are.equal(root, lsp_config.cmd_cwd)
      assert.are.equal(root, lsp_config.settings.texlab.rootDirectory)
      assert.are.equal(false, lsp_config.settings.texlab.build.onSave)
      assert.are.equal(vim.uri_from_fname(root), lsp_config.workspace_folders[1].uri)
      assert.are.equal('Paper', lsp_config.workspace_folders[1].name)
      assert.are.equal('latex', lsp_config.get_language_id(nil, 'tex'))
    end)

    it('preserves existing Neovim LSP server configuration', function()
      local root = '/tmp/overleaf.nvim-lsp-test/Paper'
      local on_attach = function() end
      vim.lsp.config.texlab = {
        cmd = { 'custom-texlab' },
        on_attach = on_attach,
        settings = { texlab = { diagnosticsDelay = 123 } },
        capabilities = { workspace = { didChangeWatchedFiles = { dynamicRegistration = true } } },
      }

      local lsp_config = buffer._lsp_server_config({ name = 'texlab', cmd = { 'texlab' } }, root, { tex = 'latex' })

      assert.are.equal('custom-texlab', lsp_config.cmd[1])
      assert.are.equal(on_attach, lsp_config.on_attach)
      assert.are.equal(123, lsp_config.settings.texlab.diagnosticsDelay)
      assert.are.equal(root, lsp_config.settings.texlab.rootDirectory)
      assert.is_true(lsp_config.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration)
    end)

    it('uses supplied server settings when Neovim has no configuration registry', function()
      vim.lsp.config = nil
      local result = buffer._lsp_server_config({ name = 'texlab', cmd = { 'texlab' } }, '/tmp/project', {})
      assert.are.same({ 'texlab' }, result.cmd)
      assert.are.equal('/tmp/project', result.settings.texlab.rootDirectory)
    end)
  end)
end)
