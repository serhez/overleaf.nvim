local config = require('overleaf.config')
local ops = require('overleaf.ops')

local M = {}

local canola_registered = false

local function state() return require('overleaf')._state end

local function open_native()
  require('overleaf.tree').toggle()
end

local function ensure_canola()
  local ok, canola = pcall(require, 'canola')
  if not ok then
    return nil, 'canola.nvim is not available'
  end
  if not canola_registered then
    canola.register_adapter('canola-overleaf://', 'overleaf')
    canola_registered = true
  end
  return canola
end

local function open_canola()
  local canola, err = ensure_canola()
  if not canola then
    config.log('warn', '%s; opening native explorer', err)
    open_native()
    return
  end

  if not ops.can_use_local_mirror() then
    config.log('warn', 'Canola explorer requires sync_dir; opening native explorer')
    open_native()
    return
  end

  canola.open('canola-overleaf:///')
end

function M.open()
  if not state().connected then
    config.log('warn', 'Not connected. Run :Overleaf connect first.')
    return
  end

  local explorer = config.get().explorer or 'native'
  if explorer == 'native' then
    open_native()
  elseif explorer == 'canola' then
    open_canola()
  elseif explorer == 'oil' then
    config.log('warn', 'Oil explorer is not supported yet; opening native explorer')
    open_native()
  else
    config.log('warn', 'Unknown explorer "%s"; opening native explorer', explorer)
    open_native()
  end
end

return M
