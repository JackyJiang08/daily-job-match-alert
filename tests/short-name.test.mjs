// The company's short name in cover letters (src/cover-letter/short-name.mjs): suffix cleaning, the model's
// shortName validated against the posting, the alias table first, the fallback, and the file name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { aliasFor, aliasText, appearsInPosting, cleanCompanyName, parseAliasText, resolveShortName, validateShortName } from '../src/cover-letter/short-name.mjs';
import { LETTER_SCHEMA, BODY_SCHEMA, assembleLetter, buildCoverLetterPrompt, buildReviewPrompt, letterFileName } from '../src/cover-letter/compose.mjs';
import { generateCoverLetter, condenseCoverLetter, shortNameFrom } from '../src/cover-letter/generate.mjs';

function posting(company, description, extra = {}) {
  return { company, companyFromSource: company, companySource: 'source', title: 'Data Analyst', roleType: 'new_grad', description, ...extra };
}

const fileName = short => letterFileName(null, { name: 'Jane Doe', company: short, prefix: 'JaneDoe' });

test('cleaning drops legal suffixes, parentheses, and "The" the way the posting writes the name', () => {
  assert.equal(cleanCompanyName('Pacers Sports & Entertainment'), 'Pacers Sports & Entertainment');
  assert.equal(cleanCompanyName('PricewaterhouseCoopers (PwC)'), 'PricewaterhouseCoopers');
  assert.equal(cleanCompanyName('Hewlett Packard Enterprise'), 'Hewlett Packard Enterprise');
  assert.equal(cleanCompanyName('The Procter & Gamble Company'), 'Procter & Gamble');
  assert.equal(cleanCompanyName('Dow Jones & Company, Inc.'), 'Dow Jones');
  assert.equal(cleanCompanyName('Johnson & Johnson'), 'Johnson & Johnson');
  for (const [raw, clean] of [['Example Corp.', 'Example'], ['Example Corporation', 'Example'], ['Example, LLC', 'Example'], ['Example L.P.', 'Example'], ['Example Co.', 'Example'], ['Example Holdings, Inc.', 'Example'], ['Example Inc', 'Example']]) {
    assert.equal(cleanCompanyName(raw), clean, raw);
  }
  // "Group" goes only when the posting calls the company by the name without it.
  assert.equal(cleanCompanyName('Example Group', { text: 'At Example, analysts partner with product.' }), 'Example');
  assert.equal(cleanCompanyName('Example Group', { text: 'Example Group is a global insurer.' }), 'Example Group');
  assert.equal(cleanCompanyName('Example Group'), 'Example Group');
  // "The" stays when the posting writes it as part of the name in mid-sentence, or never drops it.
  assert.equal(cleanCompanyName('The Home Depot', { text: 'Join the team at The Home Depot. The Home Depot hires analysts.' }), 'The Home Depot');
  assert.equal(cleanCompanyName('The Procter & Gamble Company', { text: 'The Procter & Gamble Company is hiring. Procter & Gamble brands reach billions.' }), 'Procter & Gamble');
  assert.equal(cleanCompanyName('Inc.'), 'Inc.', 'nothing usable left: the name as given');
});

test('the model\'s shortName is used when the posting writes it; an abbreviation the posting never uses is refused', () => {
  const pwc = posting('PricewaterhouseCoopers (PwC)', 'At PwC, our people solve problems. PwC US is hiring data analysts.');
  assert.deepEqual(resolveShortName({ job: pwc, chainName: pwc.company, modelShortName: 'PwC' }), { name: 'PwC', source: 'model', fallback: 'PricewaterhouseCoopers', rejected: null });
  const hpe = posting('Hewlett Packard Enterprise', 'HPE is the global edge-to-cloud company. At HPE, analysts own dashboards.');
  assert.equal(resolveShortName({ job: hpe, chainName: hpe.company, modelShortName: 'HPE' }).name, 'HPE');
  const pg = posting('The Procter & Gamble Company', 'P&G serves consumers around the world. P&G analysts build forecasts.');
  assert.equal(resolveShortName({ job: pg, chainName: pg.company, modelShortName: 'P&G' }).name, 'P&G');
  const dj = posting('Dow Jones & Company, Inc.', 'Dow Jones is a global provider of news. At Dow Jones, data analysts support The Wall Street Journal.');
  assert.equal(resolveShortName({ job: dj, chainName: dj.company, modelShortName: 'Dow Jones' }).name, 'Dow Jones');
  const pacers = posting('Pacers Sports & Entertainment', 'Pacers Sports & Entertainment (PS&E) operates the Indiana Pacers. PS&E analysts work on ticketing.');
  assert.equal(resolveShortName({ job: pacers, chainName: pacers.company, modelShortName: 'PS&E' }).name, 'PS&E');
  assert.equal(resolveShortName({ job: pacers, chainName: pacers.company, modelShortName: 'Pacers Sports & Entertainment' }).name, 'Pacers Sports & Entertainment');
  const toyota = posting('Toyota Material Handling, Inc.', 'Toyota Material Handling is the leading forklift provider in North America.');
  assert.equal(resolveShortName({ job: toyota, chainName: toyota.company, modelShortName: 'Toyota Material Handling' }).name, 'Toyota Material Handling');

  // Johnson & Johnson is never shortened to J&J unless the posting itself writes J&J.
  const jnj = posting('Johnson & Johnson', 'At Johnson & Johnson, we believe health is everything. Johnson & Johnson Innovative Medicine is hiring.');
  assert.deepEqual(resolveShortName({ job: jnj, chainName: jnj.company, modelShortName: 'J&J' }), { name: 'Johnson & Johnson', source: 'fallback', fallback: 'Johnson & Johnson', rejected: { value: 'J&J', reason: 'not in the posting' } });
  const jnjShort = posting('Johnson & Johnson', 'At J&J, we believe health is everything.');
  assert.equal(resolveShortName({ job: jnjShort, chainName: jnjShort.company, modelShortName: 'J&J' }).name, 'J&J');
  // The same acronyms without the posting behind them fall back to the cleaned name.
  const bare = description => posting('Hewlett Packard Enterprise', description);
  assert.equal(resolveShortName({ job: bare('Hewlett Packard Enterprise is hiring.'), chainName: 'Hewlett Packard Enterprise', modelShortName: 'HPE' }).name, 'Hewlett Packard Enterprise');
  assert.equal(resolveShortName({ job: posting('PricewaterhouseCoopers (PwC)', 'PricewaterhouseCoopers is hiring.'), chainName: 'PricewaterhouseCoopers (PwC)', modelShortName: 'PwC' }).name, 'PricewaterhouseCoopers', 'the parentheses in the company name are not the posting');
});

test('validation: in the posting (case and whole word), or the cleaned name; at most four words; usable as a name', () => {
  const job = posting('Dow Jones & Company, Inc.', 'Dow Jones is a global provider of news and business information.');
  assert.deepEqual(validateShortName('Dow Jones', { job, chainName: job.company }), { ok: true, reason: 'in the posting' });
  assert.deepEqual(validateShortName('DJ', { job, chainName: job.company }), { ok: false, reason: 'not in the posting' });
  assert.deepEqual(validateShortName('dow jones', { job, chainName: job.company }), { ok: true, reason: 'the cleaned company name' }, 'the cleaned name passes in any case');
  assert.equal(validateShortName('Dow', { job, chainName: job.company }).ok, true, '"Dow" stands on its own in "Dow Jones"');
  assert.equal(validateShortName('Jone', { job, chainName: job.company }).ok, false, 'part of a word is not a name');
  const long = posting('Example', 'Example Global Data Analytics Services is hiring.');
  assert.deepEqual(validateShortName('Example Global Data Analytics Services', { job: long, chainName: 'Example' }), { ok: false, reason: 'more than 4 words' });
  assert.equal(validateShortName('Pacers Sports & Entertainment', { job: posting('x', 'Pacers Sports & Entertainment'), chainName: 'x' }).ok, true, '"&" is not a word');
  assert.deepEqual(validateShortName('Inc.', { job, chainName: job.company }), { ok: false, reason: 'not a usable company name' });
  assert.deepEqual(validateShortName('  ', { job, chainName: job.company }), { ok: false, reason: 'empty' });
  assert.equal(appearsInPosting('P&G', 'Join P&amp;G today.'), true, 'HTML entities in a scraped description still match');
  assert.equal(appearsInPosting('PwC', 'Join PWC today.'), false);
});

test('the alias table wins over the model; Settings parses and reprints it', () => {
  const { aliases, errors } = parseAliasText('# full = short\nPricewaterhouseCoopers = PwC\nThe Procter & Gamble Company => P&G\nHewlett Packard Enterprise → HPE\n\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(aliases, [{ full: 'PricewaterhouseCoopers', short: 'PwC' }, { full: 'The Procter & Gamble Company', short: 'P&G' }, { full: 'Hewlett Packard Enterprise', short: 'HPE' }]);
  assert.equal(aliasText(aliases), 'PricewaterhouseCoopers = PwC\nThe Procter & Gamble Company = P&G\nHewlett Packard Enterprise = HPE');
  assert.match(parseAliasText('no separator here').errors[0], /Line 1: write "Full Name = Short Name"/);
  assert.match(parseAliasText('Example = Inc.').errors[0], /needs a company name on both sides/);
  assert.match(parseAliasText('Example = One Two Three Four Five').errors[0], /longer than 4 words/);
  assert.match(parseAliasText('Example = Ex\nexample = EX').errors[0], /listed twice/);

  // The alias matches the chain's name as written or cleaned ("PricewaterhouseCoopers (PwC)" → "PricewaterhouseCoopers").
  const pwc = posting('PricewaterhouseCoopers (PwC)', 'PricewaterhouseCoopers is hiring.');
  assert.equal(aliasFor(aliases, { job: pwc, chainName: pwc.company }), 'PwC');
  assert.deepEqual(resolveShortName({ job: pwc, chainName: pwc.company, aliases, modelShortName: 'PricewaterhouseCoopers' }), { name: 'PwC', source: 'alias', fallback: 'PricewaterhouseCoopers', rejected: null }, 'the alias beats the model, even where the posting lacks it');
  const pg = posting('The Procter & Gamble Company', 'Procter & Gamble is hiring.');
  assert.equal(resolveShortName({ job: pg, chainName: pg.company, aliases: [{ full: 'Procter & Gamble', short: 'P&G' }] }).name, 'P&G', 'a key written without "The" or "Company" still matches');
  // A name the owner typed in the panel wins over the alias.
  assert.deepEqual(resolveShortName({ job: pg, chainName: pg.company, aliases, fixed: 'Procter & Gamble' }).source, 'owner');
});

test('the salutation and the file name use the short name, with spaces and special characters removed from the file name', () => {
  const letter = assembleLetter({ profile: { name: 'Jane Doe', signatureName: 'Jane Doe' }, company: 'P&G', paragraphs: ['One.'], now: new Date('2026-11-04T15:00:00Z'), timeZone: 'America/Chicago' });
  assert.equal(letter.salutation, 'Dear P&G Recruiting Team,');
  assert.equal(fileName('P&G'), 'JaneDoe_Cover_Letter_PG.pdf');
  assert.equal(fileName('Dow Jones'), 'JaneDoe_Cover_Letter_DowJones.pdf');
  assert.equal(fileName('Toyota Material Handling'), 'JaneDoe_Cover_Letter_ToyotaMaterialHandling.pdf');
  assert.equal(fileName('Pacers Sports & Entertainment'), 'JaneDoe_Cover_Letter_PacersSportsEntertainment.pdf');
  assert.equal(fileName('Johnson & Johnson'), 'JaneDoe_Cover_Letter_JohnsonJohnson.pdf');
  assert.equal(fileName("Macy's / Bloomingdale's"), 'JaneDoe_Cover_Letter_MacysBloomingdales.pdf');
  assert.equal(fileName('Nestlé'), 'JaneDoe_Cover_Letter_Nestle.pdf');
});

test('the draft prompt asks for shortName (or names the alias); the editor checks the short name; condensing returns the body only', () => {
  assert.deepEqual(LETTER_SCHEMA.required, ['paragraphs', 'shortName']);
  assert.deepEqual(BODY_SCHEMA.required, ['paragraphs']);
  const base = { playbook: 'P', track: { id: 'data', label: 'Data' }, resumeText: 'R', job: posting('Johnson & Johnson', 'At Johnson & Johnson…') };
  const asked = buildCoverLetterPrompt(base);
  assert.match(asked, /Company naming: return "shortName", the name the company most often uses for itself in the JOB POSTING description \(for example PwC, HPE, P&G, Dow Jones, Toyota Material Handling\): at most 4 words/);
  assert.match(asked, /Never coin an abbreviation or acronym the posting does not use \(Johnson & Johnson stays Johnson & Johnson unless the posting itself writes J&J\)/);
  assert.match(asked, /the first mention of the company may use its full name the way the posting writes it; every later mention uses the short name/);
  assert.match(buildCoverLetterPrompt({ ...base, shortName: 'J&J' }), /Company naming: the company's short name is "J&J"\. Return exactly that as "shortName"\./);
  const review = buildReviewPrompt({ paragraphs: ['x'], job: base.job, resumeText: 'R', playbook: 'P', company: 'P&G' });
  assert.match(review, /The salutation will address "P&G Recruiting Team"\. The body may name the company in full at its first mention, the way the JOB POSTING does, and must call it "P&G" after that\./);
  assert.match(review, /"salutation says P&G, body says <name>"/);
  assert.doesNotMatch(review, /Company naming:/, 'the editor returns no short name');
  assert.equal(shortNameFrom('{"paragraphs":["a"],"shortName":"HPE"}'), 'HPE');
  assert.equal(shortNameFrom({ paragraphs: [] }), null);
});

function paragraphs(mention = 'the company') {
  const filler = Array.from({ length: 95 }, (_, index) => ['data', 'model', 'team', 'metric'][index % 4]).join(' ');
  return Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1} about ${mention} ${filler}.`);
}

function engineReturning(outputs) {
  const calls = [];
  return {
    calls,
    engine: {
      id: 'claude', label: 'Claude subscription', model: 'fable',
      async generateText(prompt, context) {
        calls.push({ prompt, context });
        return { output: outputs[Math.min(calls.length - 1, outputs.length - 1)], scoringModel: 'claude-fable-5' };
      },
    },
  };
}

const inputs = (job, naming) => ({ playbook: 'P', samples: [], track: { id: 'data', label: 'Data' }, resumeText: 'R', job, naming });

test('generateCoverLetter: a valid model shortName reaches the editor and the result; a refused one falls back and is flagged', async () => {
  const hpe = posting('Hewlett Packard Enterprise', 'At HPE, analysts own dashboards for the edge-to-cloud business.');
  const valid = engineReturning([{ paragraphs: paragraphs('HPE'), shortName: 'HPE' }, { issues: [], revised_paragraphs: [] }]);
  const result = await generateCoverLetter({ engine: valid.engine, inputs: inputs(hpe, { chainName: hpe.company, aliases: [] }) });
  assert.equal(result.company, 'HPE');
  assert.deepEqual(result.shortName, { name: 'HPE', source: 'model', fallback: 'Hewlett Packard Enterprise', modelValue: 'HPE', rejected: null });
  assert.equal(valid.calls[0].context.schema, LETTER_SCHEMA);
  assert.match(valid.calls[1].prompt, /The salutation will address "HPE Recruiting Team"/);

  const jnj = posting('Johnson & Johnson', 'At Johnson & Johnson, we believe health is everything.');
  const coined = engineReturning([{ paragraphs: paragraphs('J&J'), shortName: 'J&J' }, { issues: [], revised_paragraphs: [] }]);
  const fallback = await generateCoverLetter({ engine: coined.engine, inputs: inputs(jnj, { chainName: jnj.company, aliases: [] }) });
  assert.equal(fallback.company, 'Johnson & Johnson');
  assert.deepEqual(fallback.shortName.rejected, { value: 'J&J', reason: 'not in the posting' });
  assert.match(coined.calls[1].prompt, /The salutation will address "Johnson & Johnson Recruiting Team"/);
  assert.deepEqual(fallback.issues.filter(issue => issue.kind === 'short-name').map(issue => issue.message), ['The body calls the company "J&J" (not in the posting); the salutation and file name use "Johnson & Johnson"']);

  // No shortName at all (an older engine reply): the cleaned company name.
  const silent = engineReturning([{ paragraphs: paragraphs() }, { issues: [], revised_paragraphs: [] }]);
  const dj = posting('Dow Jones & Company, Inc.', 'Dow Jones is hiring.');
  assert.equal((await generateCoverLetter({ engine: silent.engine, inputs: inputs(dj, { chainName: dj.company, aliases: [] }) })).company, 'Dow Jones');
});

test('generateCoverLetter: an alias is given to the model up front and wins over whatever it returns', async () => {
  const pwc = posting('PricewaterhouseCoopers (PwC)', 'PricewaterhouseCoopers is hiring.');
  const run = engineReturning([{ paragraphs: paragraphs(), shortName: 'PricewaterhouseCoopers' }, { issues: [], revised_paragraphs: [] }]);
  const result = await generateCoverLetter({ engine: run.engine, inputs: inputs(pwc, { chainName: pwc.company, aliases: [{ full: 'PricewaterhouseCoopers', short: 'PwC' }] }) });
  assert.equal(result.company, 'PwC');
  assert.equal(result.shortName.source, 'alias');
  assert.match(run.calls[0].prompt, /the company's short name is "PwC"/);
  const condense = engineReturning([{ paragraphs: paragraphs() }]);
  await condenseCoverLetter({ engine: condense.engine, paragraphs: paragraphs(), pages: 2 });
  assert.equal(condense.calls[0].context.schema, BODY_SCHEMA);
});

test('cleaning real-world names: a posting that only writes the legal name drops "The"; a trailing ", a … Company" goes; typography stays', () => {
  assert.equal(cleanCompanyName('The Walt Disney Company', { text: 'At The Walt Disney Company, analysts shape parks. The Walt Disney Company is hiring.' }), 'Walt Disney');
  assert.equal(cleanCompanyName('The Toro Company', { text: 'Join The Toro Company in Bloomington.' }), 'Toro');
  assert.equal(cleanCompanyName('The Home Depot', { text: 'Associates at The Home Depot serve customers.' }), 'The Home Depot', 'no suffix follows: the posting writes "The Home Depot"');
  assert.equal(cleanCompanyName('Revantage, A Blackstone Portfolio Company'), 'Revantage');
  assert.equal(cleanCompanyName('Motorola Mobility (a Lenovo Company)'), 'Motorola Mobility');
  assert.equal(cleanCompanyName('Cincinnati Children’s Hospital and Medical Center'), 'Cincinnati Children’s Hospital and Medical Center');
  assert.equal(validateShortName('Children’s', { job: { description: "Cincinnati Children's is hiring." }, chainName: 'x' }).ok, true, 'curly and straight apostrophes match each other');
});
