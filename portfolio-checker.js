import fetch from 'node-fetch';
import fs from 'fs';

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORTFOLIO_GID = '1212871419399094';
const SLACK_CHANNEL_ID = 'C06FMFMM3QR'; // #datalily-project-management
const STATE_FILE = process.env.STATE_FILE || './checked_projects.json';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getPortfolioProjects() {
  const url = `https://app.asana.com/api/1.0/portfolios/${PORTFOLIO_GID}/items?opt_fields=name,gid,completed,permalink_url`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` }
  });
  const data = await res.json();
  return data.data || [];
}

async function searchForLiveReport(projectName) {
  const cleanName = projectName.replace(/^\[(INT|EXT)\]\s*/i, '').trim();

  // Step 1: Search the web and get a natural language response
  const searchPrompt = `Search for "${cleanName}" published online. Find the live URL if it exists. Be brief.`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log(`   API key present: ${apiKey ? 'YES (length ' + apiKey.length + ')' : 'NO - MISSING'}`);

  const searchRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: searchPrompt }]
    })
  });

  const searchData = await searchRes.json();
  console.log(`   API response status: ${searchRes.status}, error: ${searchData.error ? JSON.stringify(searchData.error) : 'none'}`);
  console.log(`   Raw API response type count: ${(searchData.content||[]).map(b=>b.type).join(', ')}`);

  // Web search results come back inside tool_result blocks, not text blocks
  let searchText = '';
  for (const block of (searchData.content || [])) {
    if (block.type === 'text') {
      searchText += block.text + '\n';
    } else if (block.type === 'tool_result') {
      const inner = Array.isArray(block.content) ? block.content : [];
      for (const b of inner) {
        if (b.type === 'text') searchText += b.text + '\n';
      }
    }
  }
  // Fallback: dump raw JSON so we can see what's actually coming back
  if (!searchText.trim()) {
    searchText = JSON.stringify(searchData.content || []).slice(0, 500);
  }

  console.log(`   Search result: ${searchText.slice(0, 300)}...`);

  // Wait before second API call
  await new Promise(r => setTimeout(r, 100000));

  // Step 2: Ask Claude to interpret the search results as structured JSON
  const parseRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Based on these web search results for "${cleanName}", determine if the report is publicly live.

Search results:
${searchText}

Reply with ONLY a JSON object — no other text:
If a live public URL was found: {"found": true, "url": "https://...", "source": "domain.com"}
If not found: {"found": false}`
        }
      ]
    })
  });

  const parseData = await parseRes.json();
  const parseText = (parseData.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  try {
    const jsonMatch = parseText.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { found: false };
    console.log(`   Parsed result: ${JSON.stringify(result)}`);
    return result;
  } catch {
    console.log(`   Parse failed, raw: ${parseText}`);
    return { found: false };
  }
}

async function postToSlack(project, result) {
  const cleanName = project.name.replace(/^\[(INT|EXT)\]\s*/i, '').trim();
  const isInternal = project.name.startsWith('[INT]');
  const asanaStatus = project.completed ? '✅ Complete in Asana' : '🔄 In progress in Asana';
  const projectType = isInternal ? 'Internal project' : 'External deliverable';
  const checkedDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const body = {
    channel: SLACK_CHANNEL_ID,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🌐 Project spotted live on the web' }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${cleanName}*\n${projectType}  ·  ${asanaStatus}`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Live URL*\n<${result.url}|${result.url}>` },
          { type: 'mrkdwn', text: `*Found on*\n${result.source}` },
          { type: 'mrkdwn', text: `*Portfolio*\nArchived Projects 2026` },
          { type: 'mrkdwn', text: `*Detected*\n${checkedDate}` }
        ]
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📋 View in Asana' },
            url: project.permalink_url
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔗 View live report' },
            url: result.url,
            style: 'primary'
          }
        ]
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Posted automatically by the Datalily portfolio checker · <https://app.asana.com/0/portfolio/${PORTFOLIO_GID}/list|View full portfolio>`
          }
        ]
      }
    ]
  };

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack error: ${data.error}`);
  }

  console.log(`📣 Posted to #datalily-project-management: ${cleanName} → ${result.url}`);
}

async function main() {
  console.log(`\n🔍 Checking Archived Projects 2026 portfolio...`);
  const state = loadState();
  const projects = await getPortfolioProjects();
  console.log(`Found ${projects.length} projects in portfolio.\n`);

  let newFinds = 0;

  for (const project of projects) {
    const cleanName = project.name.replace(/^\[(INT|EXT)\]\s*/i, '').trim();

    if (state[project.gid]?.found) {
      console.log(`⏭  Already live: ${cleanName}`);
      continue;
    }

    console.log(`🔎 Searching: ${cleanName}`);
    const result = await searchForLiveReport(project.name);

    state[project.gid] = {
      name: cleanName,
      found: result.found,
      url: result.url || null,
      source: result.source || null,
      asana_completed: project.completed,
      checked_at: new Date().toISOString()
    };

    if (result.found) {
      console.log(`✅ FOUND: ${result.url}`);
      await postToSlack(project, result);
      newFinds++;
    } else {
      console.log(`   Not live yet.`);
    }

    await new Promise(r => setTimeout(r, 1000000)); // 15s delay to respect rate limits
  }

  saveState(state);
  console.log(`\n✓ Done. ${newFinds} new finds. State saved to ${STATE_FILE}`);
}

main().catch(console.error);
