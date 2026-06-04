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

  it('posts a thread message and submits a range OT op for the visual selection', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_comment_create_test = true
    vim.api.nvim_set_current_buf(bufnr)
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { 'abcde' })

    local submitted_ops
    overleaf._state.documents['doc-1'] = {
      bufnr = bufnr,
      joined = true,
      content = 'abcde',
      check_content = function() return true end,
      submit_op = function(_, ops) submitted_ops = ops end,
    }

    vim.fn.setpos("'<", { bufnr, 1, 2, 0 })
    vim.fn.setpos("'>", { bufnr, 1, 3, 0 })

    local posted_thread_id
    vim.ui.input = function(opts, callback)
      assert.are.equal('Comment: ', opts.prompt)
      callback('Please revise')
    end

    bridge.request = function(method, params, callback)
      assert.are.equal('addComment', method)
      assert.are.equal('cookie', params.cookie)
      assert.are.equal('csrf', params.csrfToken)
      assert.are.equal('project-1', params.projectId)
      assert.are.equal('Please revise', params.content)
      assert.are.equal(24, #params.threadId)
      assert.is_truthy(params.threadId:match('^%x+$'))
      posted_thread_id = params.threadId

      callback(nil, {
        content = params.content,
        user = { email = 'ada@example.com' },
        timestamp = 1710000000000,
      })
    end

    overleaf.create_comment_from_selection()

    assert.are.same({
      {
        p = 1,
        c = 'bc',
        t = posted_thread_id,
      },
    }, submitted_ops)

    assert.are.equal(1, #comments._doc_comments['doc-1'])
    assert.are.equal(posted_thread_id, comments._doc_comments['doc-1'][1].threadId)
    assert.are.equal(1, comments._doc_comments['doc-1'][1].offset)
    assert.are.equal(2, comments._doc_comments['doc-1'][1].length)
    assert.are.equal('bc', comments._doc_comments['doc-1'][1].content)

    local thread = comments._threads[posted_thread_id]
    assert.are.equal('Please revise', thread.messages[1].content)
    assert.are.equal(posted_thread_id, overleaf._state.documents['doc-1'].ranges.comments[1].op.t)
    assert.are.equal('bc', overleaf._state.documents['doc-1'].ranges.comments[1].op.c)

    vim.wait(1000, function()
      return #vim.diagnostic.get(bufnr, { namespace = comments._diag_ns }) == 1
    end)

    local diagnostic = vim.diagnostic.get(bufnr, { namespace = comments._diag_ns })[1]
    assert.are.equal('overleaf-comment', diagnostic.source)
    assert.are.equal(posted_thread_id, diagnostic.user_data.thread_id)
  end)
end)
