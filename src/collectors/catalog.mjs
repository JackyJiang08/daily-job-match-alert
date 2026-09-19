// The catalog of built-in sources: which GitHub lists exist, what each is called, and whether config
// switched it on. Shared by the pipeline (to build collectors) and the hub (to list sources on Status)
// so both agree on names and enabled state.
//
// Every GitHub list below was checked on 2026-09-18 with the GitHub API: the repository exists, its
// default branch README holds a posting table, and it was pushed within the last 30 days.
export const GITHUB_LISTS = [
  { id: 'jobrightDataAnalysisInternship', name: 'Jobright Data Analysis Internships', repo: 'jobright-ai/2026-Data-Analysis-Internship', branch: 'master', format: 'jobright', roleType: 'internship' },
  { id: 'jobrightDataAnalysisNewGrad', name: 'Jobright Data Analysis New Grad', repo: 'jobright-ai/2026-Data-Analysis-New-Grad', branch: 'master', format: 'jobright', roleType: 'new_grad' },
  { id: 'jobrightSoftwareEngineerInternship', name: 'Jobright Software Engineer Internships', repo: 'jobright-ai/2026-Software-Engineer-Internship', branch: 'master', format: 'jobright', roleType: 'internship' },
  { id: 'jobrightSoftwareEngineerNewGrad', name: 'Jobright Software Engineer New Grad', repo: 'jobright-ai/2026-Software-Engineer-New-Grad', branch: 'master', format: 'jobright', roleType: 'new_grad' },
  { id: 'vanshInternships', name: 'vanshb03 Summer 2027 Internships', repo: 'vanshb03/Summer2027-Internships', branch: 'dev', format: 'vansh', roleType: 'internship' },
  { id: 'vanshNewGrad', name: 'vanshb03 New Grad 2027', repo: 'vanshb03/New-Grad-2027', branch: 'dev', format: 'vansh', roleType: 'new_grad' },
  { id: 'zapplyInternships', name: 'Zapply Internships 2027', repo: 'zapplyjobs/Internships-2027', branch: 'main', format: 'zapply', roleType: 'internship' },
  { id: 'zapplyNewGrad', name: 'Zapply New Grad Jobs 2027', repo: 'zapplyjobs/New-Grad-Jobs-2027', branch: 'main', format: 'zapply', roleType: 'new_grad' },
  { id: 'zapplyMlInternships', name: 'Zapply ML Internships 2027', repo: 'zapplyjobs/awesome-ml-internships-2027', branch: 'main', format: 'zapply', roleType: 'internship' },
  { id: 'zapplyNewGradDataScience', name: 'Zapply New Grad Data Science 2027', repo: 'zapplyjobs/New-Grad-Data-Science-Jobs-2027', branch: 'main', format: 'zapply', roleType: 'new_grad' },
  { id: 'zshahTechInternships', name: 'zshah101 Tech Internships 2027', repo: 'zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships', branch: 'main', format: 'zshah', roleType: 'internship' },
];

export const HACKER_NEWS_SOURCE = 'Hacker News Who is Hiring';
export const REMOTEOK_SOURCE = 'RemoteOK';

function rawUrl(list) {
  return `https://raw.githubusercontent.com/${list.repo}/${list.branch}/README.md`;
}

// Built-in lists merged with config.sources.githubLists.lists[<id>] overrides ({ enabled, url }).
// The whole group can be switched off with config.sources.githubLists.enabled: false.
export function githubLists(config) {
  const group = config?.sources?.githubLists;
  const groupEnabled = group?.enabled !== false;
  const overrides = group?.lists && typeof group.lists === 'object' ? group.lists : {};
  return GITHUB_LISTS.map(list => {
    const override = overrides[list.id] && typeof overrides[list.id] === 'object' ? overrides[list.id] : {};
    return { ...list, url: override.url || rawUrl(list), enabled: groupEnabled && override.enabled !== false };
  });
}

// Every built-in source with its display name and enabled state, in the order the pipeline runs them.
export function builtinSources(config) {
  const sources = config?.sources || {};
  return [
    { id: 'simplifyInternships', name: 'SimplifyJobs Summer Internships', enabled: sources.simplifyInternships?.enabled === true },
    { id: 'simplifyNewGrad', name: 'SimplifyJobs New Grad', enabled: sources.simplifyNewGrad?.enabled === true },
    ...githubLists(config).map(list => ({ id: list.id, name: list.name, enabled: list.enabled })),
    { id: 'hackerNewsHiring', name: HACKER_NEWS_SOURCE, enabled: sources.hackerNewsHiring?.enabled !== false },
    { id: 'remoteOk', name: REMOTEOK_SOURCE, enabled: sources.remoteOk?.enabled !== false },
    { id: 'emailFiles', name: 'Email files', enabled: sources.emailFiles?.enabled === true },
    { id: 'himalaya', name: 'Himalaya job-alert mailbox', enabled: sources.himalaya?.enabled === true },
    { id: 'careerOps', name: 'career-ops history', enabled: sources.careerOps?.enabled === true },
  ];
}
