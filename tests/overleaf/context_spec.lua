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

describe('connection recovery after resuming the editor', function()
  local sync = require('overleaf.sync')
  local bridge = require('overleaf.bridge')
  local previous_state, previous_reconnect, previous_workspace, previous_timer, previous_exiting
  local attempts

  before_each(function()
    previous_state, previous_reconnect = overleaf._state, overleaf._reconnect
    previous_workspace, previous_timer, previous_exiting = sync._workspace, vim.fn.timer_start, bridge._exiting
    overleaf._state = { connected = false, manual_disconnect = false, project_id = 'project' }
    overleaf._reconnect = { attempt = 0, max_attempts = 5, in_progress = false }
    sync._workspace, bridge._exiting = { closing = false }, false
    attempts = 0
    vim.fn.timer_start = function()
      attempts = attempts + 1
      return 1000000
    end
    overleaf.setup()
  end)

  after_each(function()
    overleaf._state, overleaf._reconnect = previous_state, previous_reconnect
    sync._workspace, vim.fn.timer_start, bridge._exiting = previous_workspace, previous_timer, previous_exiting
    vim.api.nvim_clear_autocmds({ group = 'OverleafNvim', event = { 'FocusGained', 'VimResume' } })
  end)

  for _, event in ipairs({ 'FocusGained', 'VimResume' }) do
    it('retries an offline project on ' .. event .. ' without scheduling duplicate reconnects', function()
      overleaf.setup()
      vim.api.nvim_exec_autocmds(event, {})
      vim.api.nvim_exec_autocmds(event, {})
      assert.are.equal(1, attempts)
      assert.is_true(overleaf._reconnect.in_progress)
    end)
  end

  for _, condition in ipairs({ 'manual disconnect', 'online', 'no project', 'closing', 'no workspace', 'exiting' }) do
    it('does not reconnect on resume while ' .. condition, function()
      if condition == 'manual disconnect' then overleaf._state.manual_disconnect = true end
      if condition == 'online' then overleaf._state.connected = true end
      if condition == 'no project' then overleaf._state.project_id = nil end
      if condition == 'closing' then sync._workspace.closing = true end
      if condition == 'no workspace' then sync._workspace = nil end
      if condition == 'exiting' then bridge._exiting = true end
      vim.api.nvim_exec_autocmds('FocusGained', {})
      vim.api.nvim_exec_autocmds('VimResume', {})
      assert.are.equal(0, attempts)
    end)
  end

  it('starts a new retry batch on focus after the previous batch was exhausted', function()
    overleaf._reconnect.attempt = overleaf._reconnect.max_attempts
    overleaf._attempt_reconnect()
    assert.are.equal(0, attempts)
    assert.are.equal(0, overleaf._reconnect.attempt)
    vim.api.nvim_exec_autocmds('FocusGained', {})
    assert.are.equal(1, attempts)
    assert.are.equal(1, overleaf._reconnect.attempt)
  end)
end)
