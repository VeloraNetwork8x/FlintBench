import { h } from './dom.js';

/** Web page of one commit on the hosting service (GitHub, GitLab, Bitbucket), or null. */
export function commitUrl(webUrl, sha) {
  if (!webUrl || !sha) return null;
  if (/gitlab/i.test(webUrl)) return `${webUrl}/-/commit/${sha}`;
  if (/bitbucket/i.test(webUrl)) return `${webUrl}/commits/${sha}`;
  return `${webUrl}/commit/${sha}`;
}

/** A commit hash that opens the commit in the browser when the repository has a web remote. */
export function commitLink(webUrl, sha, short, tag = 'span.mono') {
  const url = commitUrl(webUrl, sha);
  if (!url) return h(tag, short);
  return h(`a.commit-link.${tag.split('.').slice(1).join('.')}`, { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open this commit in the browser', onclick: (e) => e.stopPropagation() }, short);
}
