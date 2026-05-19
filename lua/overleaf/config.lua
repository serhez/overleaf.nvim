local M = {}

M._config = {
  env_file = '.env',
  cookie = nil,
  node_path = 'node',
  base_url = 'https://www.overleaf.com', -- Overleaf instance URL (for self-hosted)
  pdf_viewer = nil, -- PDF viewer command (nil = auto-detect: 'open' on macOS, 'xdg-open' on Linux)
  pdf_dir = nil, -- PDF output directory (nil = system temp dir)
  compile = {
    backend = 'overleaf', -- 'overleaf' or 'local'
    main_file = nil, -- Main tex file for local compilation (nil = infer from Overleaf project)
    local_command = nil, -- Command/table for one-shot local compile; {main} is replaced with main_file
    local_watch_command = nil, -- Command/table for live local compile watch; {main} is replaced with main_file
    open_pdf = true, -- Open PDF after successful local compile / watch start
    auto_start_watch = false, -- Start local latexmk -pvc after connecting when backend='local'
    watch_log = false, -- Log latexmk -pvc output at debug level
  },
  sync_dir = nil, -- Local file sync directory (nil = disabled; enables external tool integration)
  explorer = 'native', -- 'native' or 'canola'
  cleanup_buffers_on_exit = true, -- Wipe overleaf:// buffers before exit so sessions don't restore dead buffers
  log_level = 'info', -- 'debug', 'info', 'warn', 'error'
}

local function merge(dst, src)
  for k, v in pairs(src) do
    if type(v) == 'table' and type(dst[k]) == 'table' then
      merge(dst[k], v)
    else
      dst[k] = v
    end
  end
end

function M.setup(opts)
  if opts then
    merge(M._config, opts)
  end
end

function M.get() return M._config end

function M.load_cookie()
  if M._config.cookie then return M._config.cookie end

  local env_file = M._config.env_file
  local paths

  if env_file:sub(1, 1) == '/' then
    -- Absolute path: use directly
    paths = { env_file }
  else
    -- Relative path: try cwd, then plugin root
    paths = {
      vim.fn.getcwd() .. '/' .. env_file,
      M.plugin_root() .. '/' .. env_file,
    }
  end

  for _, path in ipairs(paths) do
    local f = io.open(path, 'r')
    if f then
      for line in f:lines() do
        local key, value = line:match('^([^=]+)=(.+)$')
        if key == 'OVERLEAF_COOKIE' then
          M._config.cookie = value
          f:close()
          return value
        end
      end
      f:close()
    end
  end

  return nil
end

function M.plugin_root()
  -- Resolve plugin root from this file's location
  local source = debug.getinfo(1, 'S').source:sub(2)
  -- source = /path/to/overleaf-neovim/lua/overleaf/config.lua
  return vim.fn.fnamemodify(source, ':h:h:h')
end

function M.bridge_script() return M.plugin_root() .. '/node/bridge.js' end

function M.log(level, msg, ...)
  local levels = { debug = 0, info = 1, warn = 2, error = 3 }
  local current = levels[M._config.log_level] or 1
  local target = levels[level] or 1

  if target >= current then
    local vim_level = ({
      debug = vim.log.levels.DEBUG,
      info = vim.log.levels.INFO,
      warn = vim.log.levels.WARN,
      error = vim.log.levels.ERROR,
    })[level] or vim.log.levels.INFO

    local formatted = string.format(msg, ...)
    vim.notify('[overleaf] ' .. formatted, vim_level)
  end
end

return M
