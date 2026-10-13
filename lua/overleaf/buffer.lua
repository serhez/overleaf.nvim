local config = require('overleaf.config')
local sync = require('overleaf.sync')

local M = {}

local native_tools = {}

--- Ordinary files keep native identity and user options. Schedule optional
--- tools only after the coordinator has attached the source successfully.
function M.setup_native(buf, current)
  if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= '' then return end
  local ft = vim.bo[buf].filetype
  if ft == '' then
    ft = vim.filetype.match({ buf = buf, filename = vim.api.nvim_buf_get_name(buf) }) or ''
    if ft ~= '' then vim.bo[buf].filetype = ft end
  end
  local existing = native_tools[buf]
  if existing and existing.ft == ft then
    existing.current = current
    return
  end
  local entry = { ft = ft, current = current }
  native_tools[buf] = entry
  local function active()
    return native_tools[buf] == entry
      and vim.api.nvim_buf_is_valid(buf)
      and vim.api.nvim_buf_is_loaded(buf)
      and (not entry.current or entry.current())
  end
  local group = vim.api.nvim_create_augroup('OverleafNativeTools' .. buf, { clear = true })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    buffer = buf,
    once = true,
    callback = function()
      native_tools[buf] = nil
      vim.api.nvim_del_augroup_by_id(group)
    end,
  })
  vim.schedule(function()
    if not active() then
      if native_tools[buf] == entry then native_tools[buf] = nil end
      return
    end
    local language = ({ tex = 'latex', plaintex = 'latex', bib = 'bibtex' })[ft] or ft
    if language ~= '' then pcall(vim.treesitter.start, buf, language) end
    M._attach_lsp(buf, ft == 'plaintex' and 'tex' or ft)
    if ft == 'tex' or ft == 'plaintex' then
      M._run_chktex(buf, active)
      vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'BufWritePost' }, {
        group = group,
        buffer = buf,
        callback = function()
          if active() then M._schedule_lint(buf, active) end
        end,
      })
    end
  end)
end

--- Manually attach LSP servers to an Overleaf buffer
function M._attach_lsp(bufnr, ft)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end

  -- LSP language IDs differ from Neovim filetypes
  local lang_id_map = { tex = 'latex', bib = 'bibtex' }

  local servers = {}
  if ft == 'tex' or ft == 'bib' then
    table.insert(servers, {
      name = 'harper_ls',
      cmd = { 'harper-ls', '--stdio' },
      settings = {
        ['harper-ls'] = {
          linters = { spell_check = true, sentence_capitalization = false },
        },
      },
    })
    table.insert(servers, {
      name = 'ltex',
      cmd = { 'ltex-ls' },
      settings = { ltex = { language = 'en-US' } },
    })
    if ft == 'tex' then table.insert(servers, { name = 'texlab', cmd = { 'texlab' } }) end
  end

  local function start_servers()
    if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
    local root_dir = M._lsp_root_dir()

    -- Mason installs to ~/.local/share/nvim/mason/bin/
    local mason_bin = vim.fn.stdpath('data') .. '/mason/bin/'

    for _, srv in ipairs(servers) do
      local server_config = M._lsp_server_config(srv, root_dir, lang_id_map)
      local cmd = type(server_config.cmd) == 'table' and server_config.cmd[1] or nil
      -- Check system PATH and mason bin
      if cmd and vim.fn.executable(cmd) ~= 1 then
        local mason_cmd = mason_bin .. cmd
        if vim.fn.executable(mason_cmd) == 1 then server_config.cmd[1] = mason_cmd end
      end
      -- Skip if command not found anywhere
      if type(server_config.cmd) ~= 'table' or vim.fn.executable(server_config.cmd[1]) ~= 1 then
        config.log('debug', 'LSP %s not found, skipping', srv.name)
      elseif not M._has_lsp_client(bufnr, srv.name) then
        pcall(vim.lsp.start, server_config, {
          bufnr = bufnr,
          reuse_client = function(client, client_config)
            return client.name == client_config.name and client.config.root_dir == client_config.root_dir
          end,
        })
      end
    end

    pcall(function() vim.bo[bufnr].omnifunc = 'v:lua.vim.lsp.omnifunc' end)
  end

  start_servers()
end

function M._lsp_root_dir() return sync.dir() or vim.fn.getcwd() end

function M._lsp_capabilities()
  local capabilities = vim.lsp.protocol.make_client_capabilities()
  for _, module_name in ipairs({ 'blink.cmp', 'blink-cmp' }) do
    local ok, blink = pcall(require, module_name)
    if ok and type(blink.get_lsp_capabilities) == 'function' then
      local ok_caps, blink_capabilities = pcall(blink.get_lsp_capabilities, capabilities)
      if ok_caps and blink_capabilities then return blink_capabilities end
    end
  end
  return capabilities
end

function M._lsp_settings(server_name, root_dir, settings)
  settings = vim.deepcopy(settings or {})
  if server_name == 'texlab' and root_dir then
    settings.texlab = settings.texlab or {}
    settings.texlab.rootDirectory = root_dir
  end
  return settings
end

function M._lsp_configured_server(name)
  if type(vim.lsp.config) == 'table' and type(vim.lsp.config[name]) == 'table' then
    return vim.deepcopy(vim.lsp.config[name])
  end
  return {}
end

local function merge_config(dst, src)
  dst = vim.deepcopy(dst or {})
  for key, value in pairs(src or {}) do
    if type(value) == 'table' and type(dst[key]) == 'table' then
      dst[key] = merge_config(dst[key], value)
    else
      dst[key] = vim.deepcopy(value)
    end
  end
  return dst
end

function M._lsp_server_config(srv, root_dir, lang_id_map)
  local configured = M._lsp_configured_server(srv.name)
  local settings = merge_config(configured.settings, srv.settings)

  local server_config = merge_config(configured, {
    name = srv.name,
    cmd = vim.deepcopy(configured.cmd or srv.cmd),
    root_dir = root_dir,
    cmd_cwd = root_dir,
    settings = M._lsp_settings(srv.name, root_dir, settings),
    capabilities = configured.capabilities or M._lsp_capabilities(),
    get_language_id = function(_, filetype) return lang_id_map[filetype] or filetype end,
  })

  if root_dir then
    server_config.workspace_folders = {
      {
        uri = vim.uri_from_fname(root_dir),
        name = vim.fn.fnamemodify(root_dir, ':t'),
      },
    }
  end

  return server_config
end

function M._has_lsp_client(bufnr, name)
  local clients = {}
  if vim.lsp.get_clients then
    clients = vim.lsp.get_clients({ bufnr = bufnr, name = name })
  elseif vim.lsp.buf_get_clients then
    clients = vim.lsp.buf_get_clients(bufnr)
  end

  for _, client in pairs(clients or {}) do
    if client.name == name then return true end
  end
  return false
end

--- Attach on_bytes listener to buffer for change detection
--- Run chktex linter on buffer content and report via vim.diagnostic
local _lint_ns = vim.api.nvim_create_namespace('overleaf_chktex')
local lint_timers, lint_requests = {}, {}

function M._run_chktex(bufnr, current)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
  if current and not current() then return end
  if vim.fn.executable('chktex') ~= 1 then return end
  local tick, token = vim.api.nvim_buf_get_changedtick(bufnr), {}
  lint_requests[bufnr] = token

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local content = table.concat(lines, '\n')

  local stdout_chunks = {}

  local job_id = vim.fn.jobstart({ 'chktex', '-q', '-f', '%l:%c:%d:%k:%m\n', '--inputfiles=0' }, {
    stdin = 'pipe',
    stdout_buffered = true,
    on_stdout = function(_, data)
      if data then stdout_chunks = data end
    end,
    on_exit = function(_, _exit_code)
      vim.schedule(function()
        if
          not vim.api.nvim_buf_is_valid(bufnr)
          or not vim.api.nvim_buf_is_loaded(bufnr)
          or lint_requests[bufnr] ~= token
          or vim.api.nvim_buf_get_changedtick(bufnr) ~= tick
          or (current and not current())
        then
          return
        end
        lint_requests[bufnr] = nil

        local diagnostics = {}
        for _, line in ipairs(stdout_chunks) do
          local lnum, col, len, kind, msg = line:match('^(%d+):(%d+):(%d+):(%w+):(.+)$')
          if lnum then
            local severity = vim.diagnostic.severity.WARN
            if kind == 'Error' then
              severity = vim.diagnostic.severity.ERROR
            elseif kind == 'Message' then
              severity = vim.diagnostic.severity.INFO
            end
            table.insert(diagnostics, {
              lnum = tonumber(lnum) - 1,
              col = tonumber(col) - 1,
              end_col = tonumber(col) - 1 + tonumber(len),
              severity = severity,
              message = msg,
              source = 'chktex',
            })
          end
        end

        vim.diagnostic.set(_lint_ns, bufnr, diagnostics)
      end)
    end,
  })

  if job_id > 0 then
    vim.fn.chansend(job_id, content)
    vim.fn.chanclose(job_id, 'stdin')
  end
end

--- Schedule chktex lint with debounce
function M._schedule_lint(bufnr, current)
  local previous = lint_timers[bufnr]
  if previous and not previous:is_closing() then
    previous:stop()
    previous:close()
  end
  lint_timers[bufnr] = vim.defer_fn(function()
    lint_timers[bufnr] = nil
    M._run_chktex(bufnr, current)
  end, 1000)
end

return M
