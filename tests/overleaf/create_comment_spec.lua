local bridge = require('overleaf.bridge')
local comments = require('overleaf.comments')
local config = require('overleaf.config')
local overleaf = require('overleaf')

describe('creating comments', function()
  local original_bridge_request
  local original_ui_input
  local original_state
  local original_threads
  local original_doc_comments
  local original_doc_contents
  local original_cookie

  before_each(function()
    original_bridge_request = bridge.request
    original_ui_input = vim.ui.input
    original_state = vim.deepcopy(overleaf._state)
    original_threads = vim.deepcopy(comments._threads)
    original_doc_comments = vim.deepcopy(comments._doc_comments)
    original_doc_contents = vim.deepcopy(comments._doc_contents)
    original_cookie = config.get().cookie

    overleaf._state.connected = true
    overleaf._state.project_id = 'project-1'
    overleaf._state.csrf_token = 'csrf'
    overleaf._state.user_id = 'user-1'
    overleaf._state.user_email = 'ada@example.com'
    overleaf._state.documents = {}
    config.get().cookie = 'cookie'

    comments._threads = {}
    comments._doc_comments = {}
    comments._doc_contents = {}
  end)

  after_each(function()
    bridge.request = original_bridge_request
    vim.ui.input = original_ui_input

    for key in pairs(overleaf._state) do
      overleaf._state[key] = nil
    end
    for key, value in pairs(original_state) do
      overleaf._state[key] = value
    end

    comments._threads = original_threads
    comments._doc_comments = original_doc_comments
    comments._doc_contents = original_doc_contents
    config.get().cookie = original_cookie

    for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(bufnr) and vim.b[bufnr].overleaf_comment_create_test then
        pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
      end
    end
  end)

  it('routes a native Unicode selection through the owned comment API without legacy OT', function()
    local sync = require('overleaf.sync')
    local old_workspace = sync._workspace
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_comment_create_test = true
    vim.api.nvim_set_current_buf(bufnr)
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { 'UNSAVED é😀 abc' })
    local doc = { bufnr = bufnr, doc_id = 'doc-1', engine = true, joined = true, content = 'UNSAVED é😀 abc' }
    overleaf._state.documents['doc-1'] = doc
    sync._workspace = { session = 'session', documents = overleaf._state.documents }
    vim.fn.setpos("'<", { bufnr, 1, 16, 0 })
    vim.fn.setpos("'>", { bufnr, 1, 18, 0 })
    local posted
    vim.ui.input = function(_, callback) callback('Review') end
    bridge.request = function(method, params, callback)
      if method == 'syncComment' then
        posted = params
        callback(nil, { status = 'queued' })
      elseif method == 'getThreads' then
        callback(nil, {})
      elseif method == 'syncDocument' then
        callback(nil, { result = { comments = {} } })
      else
        error('Unexpected request: ' .. method)
      end
    end
    local ok, problem = pcall(function()
      overleaf.create_comment_from_selection()
      assert.is_not_nil(posted)
      assert.are.equal('session', posted.session)
      assert.are.equal('doc-1', posted.document)
      assert.are.equal('UNSAVED é😀 abc', posted.selection.view)
      assert.are.same({ row = 0, col = 15 }, posted.selection.start)
      assert.are.same({ row = 0, col = 18 }, posted.selection['end'])
      assert.are.equal('Review', posted.selection.message)
      assert.are.equal('UNSAVED é😀 abc', vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)[1])
    end)
    sync._workspace = old_workspace
    assert.is_true(ok, tostring(problem))
  end)

  it('cancels a pending comment prompt when its buffer or project changes', function()
    local sync = require('overleaf.sync')
    local old_workspace = sync._workspace
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_comment_create_test = true
    vim.api.nvim_set_current_buf(bufnr)
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { 'abc' })
    local doc = { bufnr = bufnr, doc_id = 'doc-1', engine = true, joined = true, content = 'abc' }
    overleaf._state.documents['doc-1'] = doc
    sync._workspace = { session = 'session', documents = overleaf._state.documents }
    vim.fn.setpos("'<", { bufnr, 1, 1, 0 })
    vim.fn.setpos("'>", { bufnr, 1, 3, 0 })
    local input, requests = nil, 0
    vim.ui.input = function(_, callback) input = callback end
    bridge.request = function() requests = requests + 1 end
    local ok, problem = pcall(function()
      overleaf.create_comment_from_selection()
      vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { 'changed' })
      input('Review')
      assert.are.equal(0, requests)
      overleaf.create_comment_from_selection()
      sync._workspace = { session = 'other', documents = {} }
      input('Review')
      assert.are.equal(0, requests)
    end)
    sync._workspace = old_workspace
    assert.is_true(ok, tostring(problem))
  end)

  it('cancels a reply prompt across disconnect or reconnect without posting it', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_comment_create_test = true
    vim.api.nvim_set_current_buf(bufnr)
    overleaf._state.documents['doc-1'] = { bufnr = bufnr, content = 'text' }
    local old_thread, generation = comments.get_thread_at_cursor, overleaf._connection_generation
    comments.get_thread_at_cursor = function() return { id = 'thread' } end
    local input, requests = nil, 0
    vim.ui.input = function(_, callback) input = callback end
    bridge.request = function() requests = requests + 1 end
    local ok, problem = pcall(function()
      overleaf.reply_comment()
      assert.is_function(input)
      overleaf._state.connected = false
      input('Offline reply')
      assert.are.equal(0, requests)
      overleaf._state.connected = true
      overleaf.reply_comment()
      overleaf._connection_generation = (generation or 0) + 1
      input('Obsolete connection reply')
      assert.are.equal(0, requests)
      overleaf.reply_comment()
      input('Current reply')
      assert.are.equal(1, requests)
    end)
    comments.get_thread_at_cursor, overleaf._connection_generation = old_thread, generation
    assert.is_true(ok, tostring(problem))
  end)
end)
