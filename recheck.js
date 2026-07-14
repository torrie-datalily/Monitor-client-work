import fetch from 'node-fetch';
import fs from 'fs';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const STATE_FILE = './checked_projects.json';

async function getRecentMessages() {
  // Get messages from the last 7 days
  const oldest = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${SLACK_CHANNEL_ID}&oldest=${oldest}&limit=100`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data.messages || [];
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  console.log('🔍 Scanning #datalily-project-management for recheck requests...');
  const messages = await getRecentMessages();
  const state = loadState();

  // Look for messages containing 🔄
  const recheckMessages = messages.filter(m => m.text && m.text.includes('🔄'));
  console.log(`Found ${recheckMessages.length} recheck request(s).`);

  let recheckCount = 0;

  for (const msg of recheckMessages) {
    console.log(`   Message: ${msg.text}`);

    // Find which project(s) in state match keywords from the message
    for (const [gid, project] of Object.entries(state)) {
      if (!project.found) continue; // only reset ones marked as found

      // Check if any word from the project name appears in the message
      const projectWords = project.name.toLowerCase()
        .split(/[\s|\/\-]+/)
        .filter(w => w.length > 3); // ignore short words

      const messageText = msg.text.toLowerCase();
      const matchCount = projectWords.filter(w => messageText.includes(w)).length;
      const matchRatio = matchCount / projectWords.length;

      if (matchRatio >= 0.4) { // at least 40% of words match
        console.log(`   ✅ Matched "${project.name}" — removing from state for recheck`);
        delete state[gid];
        recheckCount++;
      }
    }
  }

  if (recheckCount > 0) {
    saveState(state);
    console.log(`\n✓ Queued ${recheckCount} project(s) for recheck next Monday.`);
  } else {
    console.log('\nNo projects queued for recheck.');
  }
}

main().catch(console.error);
