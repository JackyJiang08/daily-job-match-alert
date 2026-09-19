// One-click cover-letter generation runs in the background of the hub process, one letter at a time.
// The manager keeps the current job's state (idle → generating → ready | failed) so the Reports page can
// poll it, and refuses a second start while one is generating.
export class LetterBusyError extends Error {
  constructor(job) {
    super(`Another cover letter is generating (${job.company || job.jobId}); wait for it to finish`);
    this.name = 'LetterBusyError';
    this.code = 'LETTER_BUSY';
    this.status = 409;
    this.job = job;
  }
}

export function createLetterJobs({ now = () => new Date() } = {}) {
  let current = null;
  let sequence = 0;

  function snapshot(job) {
    if (!job) return { state: 'idle', busy: false, id: null };
    return {
      id: job.id, state: job.state, busy: job.state === 'generating',
      date: job.date, jobId: job.jobId, company: job.company || null,
      startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error, result: job.result,
    };
  }

  return {
    status() { return snapshot(current); },
    busy() { return current?.state === 'generating'; },
    // `run` is an async function producing { downloadUrl, openUrl, pdf, company, track }.
    start({ date, jobId, company = null, run }) {
      if (current?.state === 'generating') throw new LetterBusyError(snapshot(current));
      sequence += 1;
      const job = { id: `${date}:${jobId}:${sequence}`, date, jobId, company, state: 'generating', startedAt: now().toISOString(), finishedAt: null, error: null, result: null };
      current = job;
      job.promise = Promise.resolve().then(run).then(result => {
        job.state = 'ready';
        job.result = result;
        job.company = result?.company || job.company;
      }, error => {
        job.state = 'failed';
        job.error = String(error?.message || error || 'generation failed');
      }).then(() => { job.finishedAt = now().toISOString(); });
      return snapshot(job);
    },
    // Tests await this to observe the finished state without polling.
    async settle() { if (current?.promise) await current.promise; return snapshot(current); },
  };
}
