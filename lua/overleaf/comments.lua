local bridge = require('overleaf.bridge')
local config = require('overleaf.config')
local coordinates = require('overleaf.coordinates')
local project = require('overleaf.project')

local M = {}

local COMMENT_ICON = ''
local COMMENT_SEVERITY = vim.diagnostic.severity.HINT

M._threads = {} -- threadId -> { id, messages, resolved, resolved_by }
M._doc_comments = {} -- docId -> { { threadId, offset, length, content } }
M._doc_contents = {} -- docId -> content snapshot used for unopened comment locations
M._requests = {}
M._deleted_threads = {}
M._ns = vim.api.nvim_create_namespace('overleaf_comments')
M._diag_ns = vim.api.nvim_create_namespace('overleaf_comments_diagnostics')
M._diag_sign_ns = vim.api.nvim_create_namespace('nvim.overleaf_comments_diagnostics.diagnostic.signs')

local function hl(name)
  local ok, value = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if ok then return value end
  return {}
end

local function first_attr(attr, groups)
  for _, group in ipairs(groups) do
    local value = hl(group)[attr]
    if value then return value end
  end
end

local function blend_channel(fg, bg, alpha) return math.floor(bg + (fg - bg) * alpha + 0.5) end

local function blend(fg, bg, alpha)
  if not fg or not bg then return nil end

  local fg_r = math.floor(fg / 0x10000) % 0x100
  local fg_g = math.floor(fg / 0x100) % 0x100
  local fg_b = fg % 0x100
  local bg_r = math.floor(bg / 0x10000) % 0x100
  local bg_g = math.floor(bg / 0x100) % 0x100
  local bg_b = bg % 0x100

  return blend_channel(fg_r, bg_r, alpha) * 0x10000
    + blend_channel(fg_g, bg_g, alpha) * 0x100
    + blend_channel(fg_b, bg_b, alpha)
end

function M._setup_highlights()
  local comment_fg = first_attr('fg', {
    'DiagnosticFloatingHint',
    'DiagnosticHint',
    'DiagnosticVirtualTextHint',
    '@keyword',
    'Keyword',
    'Statement',
  })
  local comment_bg = first_attr('bg', {
    'DiagnosticVirtualTextHint',
    'DiagnosticFloatingHint',
  }) or blend(comment_fg, hl('Normal').bg, 0.16)

  local resolved_fg = first_attr('fg', { 'Comment', 'NonText', 'LineNr' })
  local resolved_bg = first_attr('bg', { 'Comment', 'Folded' }) or blend(resolved_fg, hl('Normal').bg, 0.10)

  vim.api.nvim_set_hl(0, 'OverleafComment', { underline = true, bg = comment_bg, sp = comment_fg })
  vim.api.nvim_set_hl(0, 'OverleafCommentResolved', { underline = true, bg = resolved_bg, sp = resolved_fg })
  vim.api.nvim_set_hl(0, 'OverleafCommentSign', { fg = comment_fg })
end

M._setup_highlights()
vim.api.nvim_create_autocmd('ColorScheme', {
  group = vim.api.nvim_create_augroup('overleaf_comments_highlights', { clear = true }),
  callback = function() M._setup_highlights() end,
})

vim.diagnostic.config({
  virtual_text = false,
  signs = false,
  underline = false,
  update_in_insert = false,
}, M._diag_ns)

--- Load all threads from the Overleaf API
function M.load_threads(project_id, callback)
  local context, token = require('overleaf.sync')._workspace, {}
  M._thread_request = token
  bridge.request('getThreads', {
    cookie = config.get().cookie,
    projectId = project_id,
  }, function(err, result)
    if require('overleaf.sync')._workspace ~= context or M._thread_request ~= token then
      if callback then
        callback({ code = 'SESSION_CLOSED', message = 'Project changed while loading comment threads' })
      end
      return
    end
    if err then
      config.log('error', 'Failed to load threads: %s', err.message)
      if callback then callback(err) end
      return
    end

    -- result is a table: threadId -> thread data
    M._threads = {}
    if type(result) == 'table' then
      for thread_id, thread in pairs(result) do
        M._threads[thread_id] = {
          id = thread_id,
          messages = thread.messages or {},
          resolved = thread.resolved ~= nil and thread.resolved ~= false,
          resolved_by = thread.resolved_by_user,
        }
      end
    end

    config.log('info', 'Loaded %d comment threads', vim.tbl_count(M._threads))
    if callback then callback(nil) end
  end)
end

--- Parse comment ranges from joinDoc ranges data
--- Overleaf ranges format: { comments: [{ id, op: { c, p, t } }], ... }
function M.parse_ranges(doc_id, ranges)
  M._doc_comments[doc_id] = {}

  if not ranges then
    config.log('debug', 'No ranges for doc %s', doc_id)
    return
  end

  local comments = ranges.comments
  if not comments then
    config.log('debug', 'No comments in ranges for doc %s (keys: %s)', doc_id, vim.inspect(vim.tbl_keys(ranges)))
    return
  end

  config.log('debug', 'Parsing %d comment ranges for doc %s', #comments, doc_id)

  for _, comment in ipairs(comments) do
    local op = comment.op
    if op and op.t then
      table.insert(M._doc_comments[doc_id], {
        threadId = op.t,
        offset = op.p or 0, -- character offset in document
        length = op.c and coordinates.utf8_len(op.c) or 0,
        content = op.c or '',
      })
      config.log(
        'debug',
        'Comment: thread=%s offset=%d len=%d text="%s"',
        op.t,
        op.p or 0,
        op.c and coordinates.utf8_len(op.c) or 0,
        (op.c or ''):sub(1, 30)
      )
    end
  end
end

--- Convert a character offset to line/col in a buffer
local function offset_to_pos(content, offset)
  content = content or ''
  offset = math.max(tonumber(offset) or 0, 0)

  local byte_offset = coordinates.char_to_byte(content, offset)
  local before = content:sub(1, byte_offset)
  local line = 1
  local line_start = 0
  local search_from = 1

  while true do
    local newline = before:find('\n', search_from, true)
    if not newline then break end
    line = line + 1
    line_start = newline
    search_from = newline + 1
  end

  return line, math.max(byte_offset - line_start, 0)
end

local function doc_path_for_id(doc_id)
  local entry = project.get_doc_by_id(doc_id)
  return entry and entry.path or doc_id
end

local function doc_content_for_id(doc_id)
  local ok, overleaf = pcall(require, 'overleaf')
  local doc = ok and overleaf._state and overleaf._state.documents[doc_id] or nil
  if doc and doc.content then return doc.content end
  return M._doc_contents[doc_id]
end

local function thread_summary(thread)
  if not thread or not thread.messages or #thread.messages == 0 then return '[comment]' end

  local msg = thread.messages[1]
  local user = msg.user and (msg.user.first_name or msg.user.email) or nil
  local text = (msg.content or ''):gsub('\n', ' ')
  if user and user ~= '' then return user .. ': ' .. text end
  return text ~= '' and text or '[comment]'
end

local function message_user(msg) return msg.user and (msg.user.first_name or msg.user.email) or '?' end

local function message_timestamp(msg)
  if not msg.timestamp then return '' end
  return ' (' .. os.date('%m/%d %H:%M', math.floor(msg.timestamp / 1000)) .. ')'
end

local function thread_diagnostic_message(thread)
  if not thread or not thread.messages or #thread.messages == 0 then return '[comment]' end

  local lines = {}
  for _, msg in ipairs(thread.messages or {}) do
    lines[#lines + 1] = message_user(msg) .. message_timestamp(msg) .. ':'
    for _, line in ipairs(vim.split(msg.content or '', '\n', { plain = true })) do
      lines[#lines + 1] = '  ' .. line
    end
  end
  return table.concat(lines, '\n')
end

local function upsert_doc_comment(doc_id, thread_id, offset, text)
  M._doc_comments[doc_id] = M._doc_comments[doc_id] or {}

  for _, comment in ipairs(M._doc_comments[doc_id]) do
    if comment.threadId == thread_id then
      comment.offset = offset
      comment.length = coordinates.utf8_len(text or '')
      comment.content = text or ''
      return comment
    end
  end

  local comment = {
    threadId = thread_id,
    offset = offset,
    length = coordinates.utf8_len(text or ''),
    content = text or '',
  }
  table.insert(M._doc_comments[doc_id], comment)
  return comment
end

local function upsert_thread_message(thread, message)
  if not message or not message.content then return end

  thread.messages = thread.messages or {}
  for idx, existing in ipairs(thread.messages) do
    if existing.id and message.id and existing.id == message.id then
      thread.messages[idx] = message
      return
    end
    if existing._overleaf_local and existing.content == message.content then
      thread.messages[idx] = message
      return
    end
  end

  table.insert(thread.messages, message)
end

local function comment_locations()
  local locations = {}

  for doc_id, comments in pairs(M._doc_comments) do
    local doc_path = doc_path_for_id(doc_id)
    local content = doc_content_for_id(doc_id)

    for _, c in ipairs(comments) do
      local thread = M._threads[c.threadId]
      if thread and not thread.resolved then
        local lnum, col0 = 1, 0
        if c.start then
          lnum, col0 = c.start.row + 1, c.start.col
        elseif content then
          lnum, col0 = offset_to_pos(content, c.offset)
        end

        locations[#locations + 1] = {
          doc_id = doc_id,
          path = doc_path,
          lnum = lnum,
          col = col0 + 1,
          text = thread_summary(thread),
          thread_id = c.threadId,
          comment = c,
        }
      end
    end
  end

  table.sort(locations, function(a, b)
    if a.path == b.path then
      if a.lnum == b.lnum then return a.col < b.col end
      return a.lnum < b.lnum
    end
    return a.path < b.path
  end)

  return locations
end

local function project_docs()
  local docs = {}
  for _, entry in ipairs(project._project_tree) do
    if entry.type == 'doc' then docs[#docs + 1] = entry end
  end
  table.sort(docs, function(a, b) return a.path < b.path end)
  return docs
end

--- Refresh comment threads and ranges for every text document in the project.
---@param project_id string
---@param callback? fun(err: table|nil, stats: table|nil)
function M.refresh_project_comments(project_id, callback)
  local context = require('overleaf.sync')._workspace
  if context then
    local docs, failed, index = project_docs(), 0, 0
    M.load_threads(project_id, function(err)
      if err then
        if callback then callback(err) end
        return
      end
      local function next_doc()
        if require('overleaf.sync')._workspace ~= context or context.closing then
          if callback then callback({ code = 'SESSION_CLOSED', message = 'Project changed during comment refresh' }) end
          return
        end
        index = index + 1
        local entry = docs[index]
        if not entry then
          if callback then callback(nil, { total = #docs, failed = failed }) end
          return
        end
        local doc = context.documents[entry.id]
        if not doc then
          failed = failed + 1
          vim.schedule(next_doc)
          return
        end
        M.refresh_document(doc, function(failure)
          if failure then failed = failed + 1 end
          vim.schedule(next_doc)
        end)
      end
      next_doc()
    end)
    return
  end
  if callback then
    callback({ code = 'NO_WORKSPACE', message = 'Open a project workspace before refreshing comments' })
  end
end

--- Render comment markers on a buffer using extmarks
local function render_known(bufnr, doc_id, content)
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end

  vim.api.nvim_buf_clear_namespace(bufnr, M._ns, 0, -1)
  vim.api.nvim_buf_clear_namespace(bufnr, M._diag_sign_ns, 0, -1)
  vim.diagnostic.reset(M._diag_ns, bufnr)

  local comments = M._doc_comments[doc_id]
  if not comments or #comments == 0 then
    config.log('debug', 'render: no comments for doc %s', doc_id)
    return
  end

  config.log('debug', 'render: %d comments for doc %s', #comments, doc_id)
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local diagnostics = {}
  local signed_lines = {}

  for _, c in ipairs(comments) do
    local thread = M._threads[c.threadId]
    local resolved = thread and thread.resolved or false
    if not resolved then
      local start_line, start_col, end_line, end_col
      if c.start then
        start_line, start_col, end_line, end_col = c.start.row + 1, c.start.col, c.finish.row + 1, c.finish.col
      else
        start_line, start_col = offset_to_pos(content, c.offset)
        end_line, end_col = offset_to_pos(content, c.offset + c.length)
      end

      if start_line > line_count then start_line = line_count end
      if end_line > line_count then end_line = line_count end

      -- Highlight the range (each comment gets its own highlight)
      pcall(
        function()
          c.mark = vim.api.nvim_buf_set_extmark(bufnr, M._ns, start_line - 1, start_col, {
            end_row = end_line - 1,
            end_col = end_col,
            hl_group = 'OverleafComment',
          })
        end
      )

      diagnostics[#diagnostics + 1] = {
        lnum = math.max(start_line - 1, 0),
        col = start_col,
        end_lnum = math.max(end_line - 1, 0),
        end_col = end_col,
        severity = COMMENT_SEVERITY,
        message = thread_diagnostic_message(thread),
        source = 'overleaf-comment',
        user_data = {
          thread_id = c.threadId,
          comment = c,
        },
      }

      local sign_lnum = math.max(start_line - 1, 0)
      if not signed_lines[sign_lnum] then
        signed_lines[sign_lnum] = true
        pcall(
          function()
            vim.api.nvim_buf_set_extmark(bufnr, M._diag_sign_ns, sign_lnum, 0, {
              sign_text = COMMENT_ICON,
              sign_hl_group = 'OverleafCommentSign',
              cursorline_hl_group = 'OverleafCommentSign',
              priority = 15,
            })
          end
        )
      end
    end
  end

  vim.diagnostic.set(M._diag_ns, bufnr, diagnostics)
end

function M.refresh_document(doc, callback)
  callback = callback or function() end
  local pending = M._requests[doc.doc_id]
  if pending then
    pending.again = true
    pending.callbacks[#pending.callbacks + 1] = callback
    return
  end
  local token = { callbacks = { callback } }
  local function done(err, result)
    for _, receive in ipairs(token.callbacks) do
      receive(err, result)
    end
  end
  M._requests[doc.doc_id] = token
  require('overleaf.sync').project_features(doc, {}, function(err, result, view)
    if M._requests[doc.doc_id] ~= token then
      done({ code = 'SESSION_CLOSED', message = 'Comment projection was cancelled' })
      return
    end
    M._requests[doc.doc_id] = nil
    if (not err and token.again) or (err and err.code == 'STALE_VIEW') then
      M.refresh_document(doc, done)
      return
    end
    if err then
      done(err)
      return
    end
    local comments = {}
    for _, range in ipairs(result.comments) do
      if not M._deleted_threads[range.id] then
        comments[#comments + 1] = {
          threadId = range.id,
          content = range.content,
          start = range.start,
          finish = range['end'],
          tick = view.tick,
          buf = view.buf,
        }
      end
    end
    M._doc_comments[doc.doc_id], M._doc_contents[doc.doc_id] = comments, view.content
    if view.buf and vim.api.nvim_buf_is_loaded(view.buf) then render_known(view.buf, doc.doc_id, view.content) end
    done(nil, result)
  end)
end

function M.render(bufnr, doc_id, content)
  local context = require('overleaf.sync')._workspace
  local doc = context and context.documents[doc_id]
  if doc and doc.engine and doc.bufnr == bufnr then
    M.refresh_document(doc)
    return
  end
  render_known(bufnr, doc_id, content)
end

--- Get comment thread at cursor position
function M.get_thread_at_cursor(doc_id, _content)
  local cursor = vim.api.nvim_win_get_cursor(0)
  local cursor_line = cursor[1]
  local cursor_col = cursor[2] -- 0-based byte column

  local comments = M._doc_comments[doc_id]
  if not comments then return nil end

  -- Convert cursor position to character offset
  local lines = vim.api.nvim_buf_get_lines(0, 0, cursor_line, false)
  local offset = 0
  for i = 1, #lines - 1 do
    offset = offset + coordinates.utf8_len(lines[i]) + 1 -- +1 for newline
  end
  offset = offset + coordinates.utf8_len((lines[#lines] or ''):sub(1, cursor_col))

  for _, c in ipairs(comments) do
    local contains
    if c.start then
      local first, last = c.start, c.finish
      local valid = c.buf == vim.api.nvim_get_current_buf() and c.tick == vim.api.nvim_buf_get_changedtick(c.buf)
      if c.mark and c.buf == vim.api.nvim_get_current_buf() then
        local mark = vim.api.nvim_buf_get_extmark_by_id(c.buf, M._ns, c.mark, { details = true })
        if #mark > 0 then
          first, last, valid = { row = mark[1], col = mark[2] }, { row = mark[3].end_row, col = mark[3].end_col }, true
        end
      end
      local row = cursor_line - 1
      contains = valid
        and (row > first.row or (row == first.row and cursor_col >= first.col))
        and (row < last.row or (row == last.row and cursor_col <= last.col))
    else
      contains = offset >= c.offset and offset <= c.offset + c.length
    end
    if contains then
      local thread = M._threads[c.threadId]
      if thread then return thread, c end
    end
  end
  return nil
end

--- Show a comment thread in a floating window
function M.show_thread(thread)
  if not thread then return end

  local lines = {}
  local resolved_str = thread.resolved and ' [RESOLVED]' or ''
  table.insert(lines, 'Comment Thread' .. resolved_str)
  table.insert(lines, string.rep('-', 40))

  for _, msg in ipairs(thread.messages or {}) do
    local user = msg.user and (msg.user.first_name or msg.user.email or '?') or '?'
    local ts = ''
    if msg.timestamp then ts = ' (' .. os.date('%m/%d %H:%M', msg.timestamp / 1000) .. ')' end
    table.insert(lines, user .. ts .. ':')
    -- Wrap long lines
    for _, line in ipairs(vim.split(msg.content or '', '\n', { plain = true })) do
      table.insert(lines, '  ' .. line)
    end
    table.insert(lines, '')
  end

  if #lines > 2 and lines[#lines] == '' then table.remove(lines) end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].buftype = 'nofile'

  local width = 50
  local height = math.min(#lines, 15)

  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'cursor',
    row = 1,
    col = 0,
    width = width,
    height = height,
    style = 'minimal',
    border = 'rounded',
    title = ' Comments ',
    title_pos = 'center',
  })

  -- Close on q, Esc, or when leaving the window
  local function close()
    if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
  end
  vim.keymap.set('n', 'q', close, { buffer = buf })
  vim.keymap.set('n', '<Esc>', close, { buffer = buf })
  vim.api.nvim_create_autocmd({ 'WinLeave', 'BufLeave' }, {
    buffer = buf,
    once = true,
    callback = close,
  })
end

--- Show all comments in the configured picker
function M.list_all(project_id)
  M.refresh_project_comments(project_id, function(err, stats)
    if err then return end

    local locations = comment_locations()
    if #locations == 0 then
      config.log('info', 'No open comments')
      return
    end

    vim.schedule(function()
      require('overleaf.picker').locations({
        title = 'Overleaf Comments',
        fallback = 'select',
      }, locations, function(location) require('overleaf').open_location(location) end)

      if stats and stats.failed and stats.failed > 0 then
        config.log('warn', 'Listed comments with %d document refresh failure(s)', stats.failed)
      end
    end)
  end)
end

--- Add a newly-created local comment thread and range.
---@param doc_id string
---@param thread_id string
---@param offset number Overleaf character offset
---@param selected_text string
---@param content string
---@param user table|nil
---@param message table|nil
function M.add_local_thread(doc_id, thread_id, offset, selected_text, content, user, message)
  if not doc_id or not thread_id then return end

  local thread = M._threads[thread_id]
    or {
      id = thread_id,
      messages = {},
      resolved = false,
      resolved_by = nil,
    }
  M._threads[thread_id] = thread

  local msg = type(message) == 'table' and message or {}
  if not msg.content or msg.content == '' then msg.content = content end
  if not msg.user then msg.user = user or { first_name = 'You' } end
  if not msg.timestamp then msg.timestamp = os.time() * 1000 end
  msg._overleaf_local = true

  upsert_thread_message(thread, msg)
  upsert_doc_comment(doc_id, thread_id, offset or 0, selected_text or '')
end

--- Update cached comment ranges from live OT comment operations.
---@param doc_id string
---@param ops table[]
function M.on_comment_ops(doc_id, ops)
  if not doc_id or type(ops) ~= 'table' then return end

  for _, op in ipairs(ops) do
    if op.t and op.c then upsert_doc_comment(doc_id, op.t, op.p or 0, op.c or '') end
  end
end

--- Handle socket events
function M.on_new_comment(data)
  if not data or not data.threadId then return end
  local thread = M._threads[data.threadId]
  if not thread then
    thread = {
      id = data.threadId,
      messages = {},
      resolved = false,
      resolved_by = nil,
    }
    M._threads[data.threadId] = thread
  end
  if data.comment then upsert_thread_message(thread, data.comment) end
end

function M.on_resolve_thread(data)
  if not data or not data.threadId then return end
  local thread = M._threads[data.threadId]
  if thread then
    thread.resolved = true
    thread.resolved_by = data.user
  end
end

function M.on_reopen_thread(data)
  if not data or not data.threadId then return end
  local thread = M._threads[data.threadId]
  if thread then
    thread.resolved = false
    thread.resolved_by = nil
  end
end

function M.on_delete_thread(data)
  if not data or not data.threadId then return end
  M._threads[data.threadId] = nil
  M._deleted_threads[data.threadId] = true
  -- Remove from doc_comments
  for _, comments in pairs(M._doc_comments) do
    for i = #comments, 1, -1 do
      if comments[i].threadId == data.threadId then table.remove(comments, i) end
    end
  end
end

--- Inspect retained drafts without repeating an uncertain HTTP request.
function M.review_drafts(doc, context, selection)
  local function current() return require('overleaf.sync')._workspace == context and not context.closing end
  bridge.request(
    'syncDocument',
    { session = context.session, document = doc.doc_id, action = 'state' },
    function(err, reply)
      if not current() then return end
      if err then
        config.log('error', '%s', err.message)
        return
      end
      local drafts = reply.state.comments or {}
      if #drafts == 0 then
        config.log('info', 'No retained comment drafts')
        return
      end
      vim.ui.select(drafts, {
        prompt = 'Retained comment drafts',
        format_item = function(draft) return draft.thread .. ': ' .. draft.message:gsub('\n', ' '):sub(1, 80) end,
      }, function(draft)
        if not draft or not current() then return end
        local buf = vim.api.nvim_create_buf(false, true)
        vim.bo[buf].bufhidden, vim.bo[buf].swapfile, vim.bo[buf].modeline = 'hide', false, false
        local function show(status)
          if not vim.api.nvim_buf_is_valid(buf) then return end
          vim.bo[buf].modifiable = true
          vim.api.nvim_buf_set_lines(
            buf,
            0,
            -1,
            false,
            vim.split(
              table.concat({
                'Comment draft: ' .. draft.thread,
                status,
                '',
                draft.message,
                '',
                'Selected text:',
                draft.op.c,
                '',
                'c: check whether the server received the message',
                'a: attach to the source selection captured before opening this view',
                'q: close (draft remains retained)',
                '',
                'Checking never posts the message again. If unconfirmed, inspect the thread in Overleaf.',
                'The message and selected text can be copied from this buffer.',
              }, '\n'),
              '\n',
              { plain = true }
            )
          )
          vim.bo[buf].modified, vim.bo[buf].modifiable = false, false
        end
        show(
          draft.held ~= vim.NIL and draft.held
            or (draft.posted and 'Message posted; anchor awaiting confirmation' or 'Message outcome unconfirmed')
        )
        vim.cmd('botright new')
        vim.api.nvim_win_set_buf(0, buf)
        local function received(failure, result)
          if not current() then return end
          if failure then
            show(failure.message)
            return
          end
          show(
            result.status or (result.result and result.result.held) or 'Anchor queued; awaiting applied confirmation'
          )
          if doc.controller then doc.controller:refresh() end
        end
        vim.keymap.set('n', 'c', function()
          if not current() then return end
          bridge.request('syncComment', {
            session = context.session,
            document = doc.doc_id,
            action = 'inspect',
            token = draft.token,
            cookie = config.get().cookie,
            csrfToken = require('overleaf')._state.csrf_token,
          }, received)
        end, { buffer = buf })
        vim.keymap.set('n', 'a', function()
          if not current() then return end
          if not selection or not selection.current() then
            show('Select source text again, then reopen the drafts view')
            return
          end
          bridge.request('syncDocument', {
            session = context.session,
            document = doc.doc_id,
            action = 'reanchorComment',
            token = draft.token,
            selection = { view = selection.view, start = selection.start, ['end'] = selection['end'] },
          }, received)
        end, { buffer = buf })
        vim.keymap.set('n', 'q', function() vim.api.nvim_buf_delete(buf, { force = true }) end, { buffer = buf })
      end)
    end
  )
end

function M.clear_all()
  M._threads = {}
  M._doc_comments = {}
  M._doc_contents = {}
  M._requests = {}
  M._thread_request = nil
  M._deleted_threads = {}

  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      vim.api.nvim_buf_clear_namespace(bufnr, M._ns, 0, -1)
      vim.api.nvim_buf_clear_namespace(bufnr, M._diag_sign_ns, 0, -1)
      vim.diagnostic.reset(M._diag_ns, bufnr)
    end
  end
end

M._offset_to_pos = offset_to_pos
M._comment_locations = comment_locations
M._project_docs = project_docs

return M
