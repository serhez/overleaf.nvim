local config = require('overleaf.config')
local sync = require('overleaf.sync')

local M = {}
local overleaf_actions
local placeholder_locations = {}
local uri_locations = {}
local placeholder_jumping = {}
local placeholder_seq = 0
local uri_autocmds_installed = false

local function location_key(lnum, col)
  return ('%d:%d'):format(tonumber(lnum) or 1, tonumber(col) or 1)
end

local function normalize_location(location)
  local ret = vim.deepcopy(location or {})
  ret.doc_id = ret.doc_id or ret.id
  ret.path = ret.path or ret.file
  ret.lnum = ret.lnum or ret.line or 1
  ret.col = ret.col or 1
  return ret
end

local function resolve_placeholder_location(bufnr, lnum, col)
  local pending = placeholder_locations[bufnr]
  if not pending then return nil end

  local location = pending.by_key and pending.by_key[location_key(lnum, col)]
    or pending.by_line and pending.by_line[tonumber(lnum) or 1]
    or pending.default

  if not location then return nil end

  local ret = normalize_location(location)
  ret.bufnr = bufnr
  ret.lnum = ret.lnum or lnum
  ret.col = ret.col or col
  return ret
end

local function launcher_name(path)
  placeholder_seq = placeholder_seq + 1
  return ('overleaf-qf://%d/%s'):format(placeholder_seq, path or 'location')
end

local function set_placeholder_lines(bufnr, info)
  local line_count = math.max(info and info.max_lnum or 1, 1)
  local lines = {}
  for i = 1, line_count do
    lines[i] = info and info.lines and info.lines[i] or ''
  end

  vim.bo[bufnr].buftype = 'nofile'
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].buflisted = true
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modified = false
  vim.b[bufnr].overleaf_qf_placeholder = true
end

local function open_placeholder_location(bufnr)
  if placeholder_jumping[bufnr] then return end

  vim.schedule(function()
    if not vim.api.nvim_buf_is_valid(bufnr) then return end

    local win
    for _, candidate in ipairs(vim.fn.win_findbuf(bufnr)) do
      if vim.api.nvim_win_get_config(candidate).relative == '' then
        win = candidate
        break
      end
    end
    if not win or placeholder_jumping[bufnr] then return end

    local cursor = vim.api.nvim_win_get_cursor(win)
    local open_location = resolve_placeholder_location(bufnr, cursor[1], cursor[2] + 1)
    if not open_location then return end

    local path = open_location.path
    local name = vim.api.nvim_buf_get_name(bufnr)
    if name:match('^overleaf://') then pcall(vim.api.nvim_buf_set_name, bufnr, launcher_name(path)) end

    open_location.bufnr = nil
    open_location.winid = win
    placeholder_jumping[bufnr] = true

    require('overleaf').open_location(open_location)

    vim.defer_fn(function() placeholder_jumping[bufnr] = nil end, 250)
  end)
end

local function install_placeholder_autocmd(bufnr)
  if vim.b[bufnr].overleaf_qf_autocmd then return end

  vim.b[bufnr].overleaf_qf_autocmd = true
  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWinEnter', 'CursorMoved' }, {
    buffer = bufnr,
    callback = function()
      if not placeholder_locations[bufnr] then return end
      open_placeholder_location(bufnr)
    end,
  })
end

local function normalize_path_info(path, info)
  local location = normalize_location(info and info.location or { path = path })
  location.path = path

  return {
    default = location,
    by_line = info and info.by_line or nil,
    by_key = info and info.by_key or nil,
    lines = info and info.lines or nil,
    max_lnum = info and info.max_lnum or location.lnum or 1,
  }
end

local function register_uri_location(path, info)
  uri_locations[path] = normalize_path_info(path, info)

  local bufnr = vim.fn.bufnr(sync.buf_name(path))
  if bufnr ~= -1 and vim.api.nvim_buf_is_valid(bufnr) and vim.b[bufnr].overleaf_qf_placeholder == true then
    placeholder_locations[bufnr] = uri_locations[path]
    set_placeholder_lines(bufnr, uri_locations[path])
    install_placeholder_autocmd(bufnr)
  end
end

local function ensure_uri_autocmds()
  if uri_autocmds_installed then return end
  uri_autocmds_installed = true

  local group = vim.api.nvim_create_augroup('OverleafPickerUri', { clear = true })
  vim.api.nvim_create_autocmd('BufReadCmd', {
    group = group,
    pattern = 'overleaf://*',
    callback = function(event)
      local path = event.match:gsub('^overleaf://', '')
      local info = uri_locations[path] or normalize_path_info(path)

      uri_locations[path] = info
      placeholder_locations[event.buf] = info
      set_placeholder_lines(event.buf, info)
      install_placeholder_autocmd(event.buf)
    end,
  })
end

local function preferred_provider()
  local picker = config.get().picker or 'auto'
  if picker == 'native' then return 'native' end

  local ok, snacks = pcall(require, 'snacks')
  if ok and snacks and snacks.picker then return 'snacks', snacks end

  if picker == 'snacks' then config.log('warn', 'snacks.picker requested but unavailable; using native picker') end
  return 'native'
end

function M.snacks()
  local provider, snacks = preferred_provider()
  if provider == 'snacks' then return snacks end
  return nil
end

local function format_default(item)
  if type(item) ~= 'table' then return tostring(item) end
  return item.label or item.path or item.name or item.text or tostring(item)
end

local function matches_query(text, query)
  query = vim.trim(query or '')
  if query == '' then return true end

  local haystack = text:lower()
  for term in query:lower():gmatch('%S+') do
    if not haystack:find(term, 1, true) then return false end
  end
  return true
end

local function document_items(entries, query)
  local items = {}
  for _, entry in ipairs(entries or {}) do
    if entry.type == 'doc' and matches_query(entry.path, query) then
      items[#items + 1] = {
        text = entry.path,
        path = entry.path,
        item = entry,
      }
    end
  end
  return items
end

local function document_format(item, _picker)
  return {
    { item.path or item.text or '?', 'SnacksPickerFile' },
  }
end

function M.select(items, opts, callback)
  opts = opts or {}
  callback = callback or function() end

  if not items or #items == 0 then
    if opts.empty_message then config.log('info', opts.empty_message) end
    return
  end

  local provider, snacks = preferred_provider()
  local format_item = opts.format_item or format_default

  if provider == 'snacks' then
    return snacks.picker.select(items, {
      prompt = opts.prompt,
      format_item = format_item,
      snacks = opts.snacks,
    }, callback)
  end

  return vim.ui.select(items, {
    prompt = opts.prompt,
    format_item = format_item,
  }, callback)
end

function M.documents(entries, callback)
  callback = callback or function() end

  local docs = {}
  for _, entry in ipairs(entries or {}) do
    if entry.type == 'doc' then docs[#docs + 1] = entry end
  end

  if #docs == 0 then
    config.log('info', 'No documents in project')
    return
  end

  local snacks = M.snacks()
  if not snacks then
    return M.select(docs, {
      prompt = 'Select Document:',
      format_item = function(item) return item.path end,
    }, function(choice)
      if choice then callback(choice.id, choice.path) end
    end)
  end

  return snacks.picker({
    title = 'Overleaf Documents',
    finder = function(_, ctx) return document_items(docs, ctx.filter.search) end,
    format = document_format,
    preview = 'none',
    live = true,
    actions = overleaf_actions(),
    confirm = function(picker, item)
      picker:close()
      if item and item.item then vim.schedule(function() callback(item.item.id, item.item.path) end) end
    end,
  })
end

local function location_text(location)
  local path = location.path or location.file or '?'
  local line = location.lnum or location.line or 1
  local col = location.col or 1
  local text = location.text or location.line_text or ''
  return ('%s:%d:%d %s'):format(path, line, col, text)
end

local function location_format(item, _picker)
  local ret = {}
  local line = item.lnum or 1
  local col = item.col or 1

  ret[#ret + 1] = { item.path or '?', 'SnacksPickerFile' }
  ret[#ret + 1] = { ':', 'SnacksPickerDelim' }
  ret[#ret + 1] = { tostring(line), 'SnacksPickerRow' }
  ret[#ret + 1] = { ':', 'SnacksPickerDelim' }
  ret[#ret + 1] = { tostring(col), 'SnacksPickerCol' }
  ret[#ret + 1] = { ' ' }

  if item.line then
    require('snacks').picker.highlight.format(item, item.line, ret)
  end

  return ret
end

local function qf_items(locations)
  local buffers = {}
  local by_path = {}

  ensure_uri_autocmds()

  for _, location in ipairs(locations) do
    local path = location.path or location.file
    if path then
      local info = by_path[path] or {
        max_lnum = 1,
        lines = {},
        location = location,
        by_line = {},
        by_key = {},
      }
      local lnum = location.lnum or location.line or 1
      local col = location.col or 1
      info.max_lnum = math.max(info.max_lnum, lnum)
      info.lines[lnum] = location.text or location.line_text or info.lines[lnum] or ''
      info.by_line[lnum] = info.by_line[lnum] or location
      info.by_key[location_key(lnum, col)] = location
      by_path[path] = info
    end
  end

  for path, info in pairs(by_path) do
    register_uri_location(path, info)
    buffers[path] = M.ensure_list_buffer(info.location, info)
  end

  local items = {}
  for _, location in ipairs(locations) do
    local path = location.path or location.file or ''
    items[#items + 1] = {
      bufnr = buffers[path],
      filename = sync.buf_name(path),
      lnum = location.lnum or location.line or 1,
      col = location.col or 1,
      text = location.text or location.line_text or '',
      user_data = location,
      valid = 1,
    }
  end
  return items
end

function M.ensure_list_buffer(location, info)
  local path = location.path or location.file
  if not path then return nil end

  ensure_uri_autocmds()
  register_uri_location(path, info or { location = location })

  local name = sync.buf_name(path)
  local required_lnum = math.max(info and info.max_lnum or location.lnum or location.line or 1, 1)
  local bufnr = vim.fn.bufnr(name)
  if bufnr ~= -1 and vim.api.nvim_buf_is_valid(bufnr) and vim.b[bufnr].overleaf_qf_placeholder ~= true then
    if vim.api.nvim_buf_is_loaded(bufnr) and vim.api.nvim_buf_line_count(bufnr) >= required_lnum then
      return bufnr
    end

    bufnr = vim.api.nvim_create_buf(true, false)
    vim.bo[bufnr].buftype = 'nofile'
    vim.bo[bufnr].swapfile = false
    vim.api.nvim_buf_set_name(bufnr, launcher_name(path))
  end

  if bufnr == -1 or not vim.api.nvim_buf_is_valid(bufnr) then
    bufnr = vim.api.nvim_create_buf(true, false)
    vim.bo[bufnr].buftype = 'nofile'
    vim.bo[bufnr].swapfile = false
    vim.api.nvim_buf_set_name(bufnr, name)
  end

  placeholder_locations[bufnr] = uri_locations[path]
  set_placeholder_lines(bufnr, uri_locations[path])
  install_placeholder_autocmd(bufnr)

  return bufnr
end

local function open_location_list(title, locations, callback, opts)
  opts = opts or {}
  opts.win = opts.win and vim.api.nvim_win_is_valid(opts.win) and opts.win or nil

  if opts.win then
    vim.fn.setloclist(opts.win, {}, 'r', {
      title = title,
      items = qf_items(locations),
    })
    vim.cmd('botright lopen')
  else
    vim.fn.setqflist({}, 'r', {
      title = title,
      items = qf_items(locations),
    })
    vim.cmd('botright copen')
  end

  local list_win = opts.win
  local close_cmd = opts.win and 'lclose' or 'cclose'

  local qf_buf = vim.api.nvim_get_current_buf()
  local function jump_current()
    local list = list_win and vim.fn.getloclist(list_win) or vim.fn.getqflist()
    local item = list[vim.fn.line('.')]
    local location = item and item.user_data
    if not location then return end

    vim.cmd(close_cmd)
    callback(location)
  end

  vim.keymap.set('n', '<CR>', jump_current, { buffer = qf_buf, nowait = true, desc = 'Open Overleaf location' })
  vim.keymap.set('n', 'o', jump_current, { buffer = qf_buf, nowait = true, desc = 'Open Overleaf location' })
  vim.keymap.set('n', '<2-LeftMouse>', jump_current, { buffer = qf_buf, desc = 'Open Overleaf location' })
  vim.keymap.set('n', 'q', '<cmd>' .. close_cmd .. '<CR>', { buffer = qf_buf, nowait = true })
end

local function open_quickfix(title, locations, callback)
  open_location_list(title, locations, callback)
end

function M.quickfix(title, locations, callback, opts)
  open_location_list(title, locations, callback or function() end, opts)
end

local function picker_items_to_locations(items)
  local locations = {}
  for _, item in ipairs(items or {}) do
    local source = item.item or item
    local path = source.path or source.file or item.path or item.file

    if path then
      locations[#locations + 1] = {
        doc_id = source.doc_id or source.id or item.doc_id or item.id,
        path = path,
        lnum = source.lnum or source.line or item.lnum or item.line or 1,
        col = source.col or item.col or 1,
        text = source.text or source.line_text or item.line or item.text or path,
      }
    end
  end
  return locations
end

local function picker_list_action(kind)
  return function(picker)
    local selected = picker:selected()
    local items = #selected > 0 and selected or picker:items()
    local locations = picker_items_to_locations(items)
    local title = picker.opts.title or 'Overleaf Locations'
    local win = picker.main

    picker:close()

    if #locations == 0 then
      config.log('info', 'No Overleaf locations to send to list')
      return
    end

    open_location_list(title, locations, function(location) require('overleaf').open_location(location) end, {
      win = kind == 'loclist' and win or nil,
    })
  end
end

local overleaf_list_actions = {
  qflist = picker_list_action('qflist'),
  qflist_all = function(picker)
    local locations = picker_items_to_locations(picker:items())
    local title = picker.opts.title or 'Overleaf Locations'
    picker:close()
    if #locations == 0 then
      config.log('info', 'No Overleaf locations to send to list')
      return
    end
    open_location_list(title, locations, function(location) require('overleaf').open_location(location) end)
  end,
  loclist = picker_list_action('loclist'),
}

overleaf_actions = function(extra)
  return vim.tbl_extend('force', overleaf_list_actions, extra or {})
end

function M.locations(opts, locations, callback)
  opts = opts or {}
  callback = callback or function() end

  if not locations or #locations == 0 then
    if opts.empty_message then config.log('info', opts.empty_message) end
    return
  end

  local title = opts.title or 'Overleaf Locations'
  local provider, snacks = preferred_provider()

  if provider == 'snacks' then
    local items = {}
    for idx, location in ipairs(locations) do
      items[#items + 1] = {
        text = location_text(location),
        idx = idx,
        item = location,
        path = location.path or location.file,
        lnum = location.lnum or location.line or 1,
        col = location.col or 1,
        line = location.text or location.line_text or '',
      }
    end

    snacks.picker({
      title = title,
      items = items,
      format = location_format,
      preview = 'none',
      actions = overleaf_actions(),
      confirm = function(picker, item)
        picker:close()
        if item and item.item then vim.schedule(function() callback(item.item) end) end
      end,
    })
    return
  end

  if opts.fallback == 'select' then
    return M.select(locations, {
      prompt = title .. ':',
      format_item = location_text,
    }, callback)
  end

  open_quickfix(title, locations, callback)
end

function M.live_locations(opts, finder, callback)
  opts = opts or {}
  callback = callback or function() end

  local snacks = M.snacks()
  if not snacks then return nil end

  return snacks.picker({
    title = opts.title or 'Overleaf Search',
    finder = finder,
    format = location_format,
    preview = 'none',
    live = true,
    actions = overleaf_actions(),
    confirm = function(picker, item)
      picker:close()
      if item and item.item then vim.schedule(function() callback(item.item) end) end
    end,
  })
end

M._qf_items = qf_items
M._document_items = document_items
M._picker_items_to_locations = picker_items_to_locations
M._resolve_placeholder_location = resolve_placeholder_location

return M
