// Placeholder engine used when semanticMatching.engine is local_only (demo, tests, and dry runs). It never
// contacts a model: generateText returns deterministic placeholder paragraphs, and it cannot score jobs.
export const FAKE_ENGINE_LABEL = 'Local placeholder (no model)';

function placeholderParagraphs(prompt) {
  const company = /"company":\s*"([^"]*)"/.exec(prompt)?.[1] || 'the company';
  const title = /"title":\s*"([^"]*)"/.exec(prompt)?.[1] || 'this role';
  return [
    `I am writing to apply for the ${title} position at ${company}. This paragraph is placeholder text produced by the local engine, so it carries no claims about the candidate; switch the engine to Claude or Codex in Settings to generate a real letter.`,
    `A real letter would open with the strongest match between the role and the resume evidence, naming one project and one measurable result drawn only from the playbook and the selected resume track.`,
    `The second body paragraph would address the core responsibilities in the job description, again citing facts and numbers that exist in the evidence library rather than inventing new ones.`,
    `Where the posting asks for a skill the resume does not show, the letter would follow the playbook's fast-ramp framework: name an adjacent skill, describe how it transfers, and commit to a concrete ramp plan.`,
    `Finally, the closing paragraph would state the graduation timeline wording that matches this role type, express interest in the team, and thank the reader for their time.`,
  ];
}

export function createFakeEngine(options = {}) {
  const model = options.model || 'placeholder';
  return {
    id: 'local_only',
    label: FAKE_ENGINE_LABEL,
    model,
    async verifyAuth() { return { accepted: true }; },
    async reviewBatch() { throw new Error('The local placeholder engine cannot score jobs'); },
    describeModel() { return { engine: 'local_only', model, label: FAKE_ENGINE_LABEL }; },
    modelMatches() { return true; },
    async describeConnection() { return { installed: true, connected: true, detail: FAKE_ENGINE_LABEL, hint: null, reason: null }; },
    async generateText(prompt) {
      const text = String(prompt || '');
      // Editor pass: nothing to flag for placeholder text.
      if (text.startsWith('EDITOR REVIEW')) return { output: { issues: [], revised_paragraphs: [] }, scoringModel: model };
      // Condensing pass: trim each paragraph of the draft by about 15 percent.
      if (text.startsWith('CONDENSE')) {
        const draftAt = text.indexOf('DRAFT:');
        const start = text.indexOf('{', draftAt >= 0 ? draftAt : 0);
        let draft = [];
        try { draft = JSON.parse(text.slice(start)).paragraphs || []; } catch {}
        const shorter = draft.map(paragraph => { const words = String(paragraph).split(/\s+/); return words.slice(0, Math.max(8, Math.ceil(words.length * 0.85))).join(' ').replace(/[,;:]$/, '') + '.'; });
        return { output: { paragraphs: shorter }, scoringModel: model };
      }
      return { output: { paragraphs: placeholderParagraphs(prompt) }, scoringModel: model };
    },
  };
}
