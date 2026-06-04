local bridge = require('overleaf.bridge')
local comments = require('overleaf.comments')
local overleaf = require('overleaf')
local picker = require('overleaf.picker')
local project = require('overleaf.project')

describe('comments', function()
  local original_threads
  local original_doc_comments
  local original_doc_contents
  local original_project_tree
  local original_documents
  local original_bridge_request
  local original_picker_locations

  before_each(function()
    original_threads = vim.deepcopy(comments._threads)
    original_doc_comments = vim.deepcopy(comments._doc_comments)
    original_doc_contents = vim.deepcopy(comments._doc_contents)
    original_project_tree = vim.deepcopy(project._project_tree)
    original_documents = vim.deepcopy(overleaf._state.documents)
    original_bridge_request = bridge.request
    original_picker_locations = picker.locations

    comments._threads = {}
    comments._doc_comments = {}
    comments._doc_contents = {}
    project._project_tree = {}
    overleaf._state.documents = {}
  end)

  after_each(function()
    comments._threads = original_threads
    comments._doc_comments = original_doc_comments
    comments._doc_contents = original_doc_contents
    project._project_tree = original_project_tree
    overleaf._state.documents = original_documents
    bridge.request = original_bridge_request
    picker.locations = original_picker_locations

    pcall(vim.cmd, 'cclose')
    for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(bufnr) and vim.b[bufnr].overleaf_comment_test == true then
        pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
      end
      if vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_get_name(bufnr):match('^overleaf://') then
        pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
      end
      if vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_get_name(bufnr):match('^overleaf%-qf://') then
        pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
      end
    end
  end)

  it('converts Overleaf character offsets to Neovim byte positions', function()
    local line, col = comments._offset_to_pos('ab\nαβ comment', 6)

    assert.are.equal(2, line)
    assert.are.equal(5, col)
  end)

  it('builds comment locations with document metadata and accurate positions', function()
    project._project_tree = {
      { id = 'doc-1', path = 'main.tex', type = 'doc' },
    }
    overleaf._state.documents['doc-1'] = {
      content = 'first\nαβ comment\nlast',
    }
    comments._threads = {
      ['thread-1'] = {
        id = 'thread-1',
        resolved = false,
        messages = {
          {
            content = 'Please revise',
            user = { first_name = 'Ada' },
          },
        },
      },
    }
    comments._doc_comments = {
      ['doc-1'] = {
        {
          threadId = 'thread-1',
          offset = 9,
          length = 7,
          content = 'comment',
        },
      },
    }

    local locations = comments._comment_locations()

    assert.are.equal(1, #locations)
    assert.are.equal('doc-1', locations[1].doc_id)
    assert.are.equal('main.tex', locations[1].path)
    assert.are.equal(2, locations[1].lnum)
    assert.are.equal(6, locations[1].col)
    assert.are.equal('Ada: Please revise', locations[1].text)
    assert.are.equal('thread-1', locations[1].thread_id)
  end)

  it('renders comments as diagnostics without ghost text', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_comment_test = true
    local content = 'first\nsecond line'
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, vim.split(content, '\n', { plain = true }))

    comments._threads = {
      ['thread-1'] = {
        id = 'thread-1',
        resolved = false,
        messages = {
          {
            content = 'Needs work\nPlease clarify.',
            user = { first_name = 'Ada' },
          },
        },
      },
    }
    comments._doc_comments = {
      ['doc-1'] = {
        {
          threadId = 'thread-1',
          offset = 6,
          length = 6,
          content = 'second',
        },
      },
    }

    comments.render(bufnr, 'doc-1', content)

    local diagnostics = vim.diagnostic.get(bufnr, { namespace = comments._diag_ns })
    assert.are.equal(1, #diagnostics)
    assert.are.equal(vim.diagnostic.severity.HINT, diagnostics[1].severity)
    assert.are.equal(1, diagnostics[1].lnum)
    assert.are.equal(0, diagnostics[1].col)
    assert.are.equal(1, diagnostics[1].end_lnum)
    assert.are.equal(6, diagnostics[1].end_col)
    assert.are.equal('overleaf-comment', diagnostics[1].source)
    assert.matches('Ada:', diagnostics[1].message)
    assert.matches('Please clarify', diagnostics[1].message)
    assert.are.equal('thread-1', diagnostics[1].user_data.thread_id)

    local extmarks = vim.api.nvim_buf_get_extmarks(bufnr, comments._ns, 0, -1, { details = true })
    assert.are.equal(1, #extmarks)
    assert.is_nil(extmarks[1][4].virt_text)

    local signs = vim.api.nvim_buf_get_extmarks(bufnr, comments._diag_sign_ns, 0, -1, { details = true, type = 'sign' })
    assert.are.equal(1, #signs)
    assert.are.equal('', signs[1][4].sign_text:gsub('%s', ''))
    assert.are.equal('OverleafCommentSign', signs[1][4].sign_hl_group)
    assert.are.equal('OverleafCommentSign', signs[1][4].cursorline_hl_group)

    local sign_hl = vim.api.nvim_get_hl(0, { name = 'OverleafCommentSign', link = false })
    local hint_hl = vim.api.nvim_get_hl(0, { name = 'DiagnosticFloatingHint', link = false })
    if hint_hl.fg then assert.are.equal(hint_hl.fg, sign_hl.fg) end

    comments._doc_comments['doc-1'] = {}
    comments.render(bufnr, 'doc-1', content)
    assert.are.equal(0, #vim.diagnostic.get(bufnr, { namespace = comments._diag_ns }))
    assert.are.equal(0, #vim.api.nvim_buf_get_extmarks(bufnr, comments._diag_sign_ns, 0, -1, { details = true, type = 'sign' }))
  end)

  it('finds the comment under the cursor using character offsets', function()
    local bufnr = vim.api.nvim_create_buf(true, false)
    vim.b[bufnr].overleaf_comment_test = true
    vim.api.nvim_set_current_buf(bufnr)
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { 'αβγδ' })

    comments._threads = {
      ['thread-1'] = {
        id = 'thread-1',
        resolved = false,
        messages = {
          {
            content = 'Delta comment',
            user = { first_name = 'Ada' },
          },
        },
      },
    }
    comments._doc_comments = {
      ['doc-1'] = {
        {
          threadId = 'thread-1',
          offset = 3,
          length = 1,
          content = 'δ',
        },
      },
    }

    vim.api.nvim_win_set_cursor(0, { 1, 6 })
    local thread, comment = comments.get_thread_at_cursor('doc-1')

    assert.are.equal('thread-1', thread.id)
    assert.are.equal('δ', comment.content)
  end)

  it('lists comments from unopened project documents through the Overleaf picker', function()
    project._project_tree = {
      { id = 'doc-1', path = 'main.tex', type = 'doc' },
      { id = 'doc-2', path = 'sections/intro.tex', type = 'doc' },
    }

    local left_docs = {}
    local picked
    picker.locations = function(opts, locations, callback)
      picked = {
        opts = opts,
        locations = locations,
        callback = callback,
      }
    end

    bridge.request = function(method, params, callback)
      if method == 'getThreads' then
        callback(nil, {
          ['thread-1'] = {
            resolved = false,
            messages = {
              {
                content = 'Needs work',
                user = { email = 'ada@example.com' },
              },
            },
          },
          ['thread-2'] = {
            resolved = false,
            messages = {
              {
                content = 'Clarify this',
                user = { first_name = 'Grace' },
              },
            },
          },
        })
      elseif method == 'joinDoc' and params.docId == 'doc-1' then
        callback(nil, {
          lines = { 'first', 'second line' },
          ranges = {
            comments = {
              { op = { t = 'thread-1', p = 6, c = 'second' } },
            },
          },
        })
      elseif method == 'joinDoc' and params.docId == 'doc-2' then
        callback(nil, {
          lines = { 'intro one', 'please fix' },
          ranges = {
            comments = {
              { op = { t = 'thread-2', p = 10, c = 'please' } },
            },
          },
        })
      elseif method == 'leaveDoc' then
        left_docs[#left_docs + 1] = params.docId
        callback(nil, {})
      else
        callback({ message = 'unexpected request: ' .. method }, nil)
      end
    end

    comments.list_all('project-1')

    vim.wait(1000, function() return picked ~= nil end)

    assert.are.equal('Overleaf Comments', picked.opts.title)
    assert.are.equal('select', picked.opts.fallback)
    assert.are.equal(2, #picked.locations)
    assert.are.equal('main.tex', picked.locations[1].path)
    assert.are.equal(2, picked.locations[1].lnum)
    assert.are.equal(1, picked.locations[1].col)
    assert.are.equal('ada@example.com: Needs work', picked.locations[1].text)
    assert.are.equal('thread-1', picked.locations[1].thread_id)

    assert.are.equal('sections/intro.tex', picked.locations[2].path)
    assert.are.equal(2, picked.locations[2].lnum)
    assert.are.equal(1, picked.locations[2].col)
    assert.are.equal('Grace: Clarify this', picked.locations[2].text)
    assert.are.equal('thread-2', picked.locations[2].thread_id)
    assert.are.same({ 'doc-1', 'doc-2' }, left_docs)
  end)

  it('keeps already-open documents joined when refreshing project comments', function()
    project._project_tree = {
      { id = 'doc-1', path = 'main.tex', type = 'doc' },
    }
    overleaf._state.documents['doc-1'] = {
      joined = true,
      content = 'first\nsecond line',
      ranges = {
        comments = {
          { op = { t = 'thread-1', p = 6, c = 'second' } },
        },
      },
    }

    local leave_called = false
    local join_called = false
    bridge.request = function(method, params, callback)
      if method == 'getThreads' then
        callback(nil, {
          ['thread-1'] = {
            resolved = false,
            messages = {
              {
                content = 'Needs work',
                user = { email = 'ada@example.com' },
              },
            },
          },
        })
      elseif method == 'joinDoc' then
        join_called = true
        callback({ message = 'joinDoc should not be called for active documents' }, nil)
      elseif method == 'leaveDoc' then
        leave_called = true
        callback(nil, {})
      else
        callback({ message = 'unexpected request: ' .. method }, nil)
      end
    end

    local done = false
    comments.refresh_project_comments('project-1', function(err, stats)
      assert.is_nil(err)
      assert.are.equal(1, stats.total)
      assert.are.equal(0, stats.failed)
      done = true
    end)

    vim.wait(1000, function() return done end)
    assert.is_true(done)
    assert.is_false(join_called)
    assert.is_false(leave_called)
    assert.are.equal(1, #comments._doc_comments['doc-1'])
  end)

  it('builds comment quickfix entries from cached project comment snapshots', function()
    project._project_tree = {
      { id = 'doc-1', path = 'main.tex', type = 'doc' },
    }
    comments._doc_contents['doc-1'] = 'first\nsecond line'
    comments._threads = {
      ['thread-1'] = {
        id = 'thread-1',
        resolved = false,
        messages = {
          {
            content = 'Needs work',
            user = { email = 'ada@example.com' },
          },
        },
      },
    }
    comments._doc_comments = {
      ['doc-1'] = {
        {
          threadId = 'thread-1',
          offset = 6,
          length = 6,
          content = 'second',
        },
      },
    }

    require('overleaf.picker').quickfix('Overleaf Comments', comments._comment_locations(), function(location)
      require('overleaf').open_location(location)
    end)

    local items = vim.fn.getqflist()
    assert.are.equal(1, #items)
    assert.are.equal('overleaf://main.tex', vim.api.nvim_buf_get_name(items[1].bufnr))
    assert.are.equal(2, items[1].lnum)
    assert.are.equal(1, items[1].col)
    assert.are.equal('ada@example.com: Needs work', items[1].text)
    assert.are.equal('thread-1', items[1].user_data.thread_id)
  end)
end)
