#!/bin/sh
#
# One-shot: remove tmp/ from the unpushed commit range.
#
# A blanket `git add -A` swept ~2,500 lines of agent scratch work into commit
# d1a00e0; a later commit deleted it, but deleting in a commit does not remove
# the objects — pushing the branch would publish every one of those files
# permanently. Nothing has been pushed yet (origin/main is still at the initial
# commit), so rewriting is safe right now and stops being safe the moment you
# push.
#
# Run from the repository root. A backup tag `backup-pre-rewrite` already
# exists; verify the result before deleting it.
set -eu

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

BASE=$(git rev-list --max-parents=0 HEAD)   # the initial commit
echo "Rewriting ${BASE}..HEAD to remove tmp/"

git tag -f backup-pre-rewrite >/dev/null
echo "Backup tag: backup-pre-rewrite -> $(git rev-parse --short backup-pre-rewrite)"

# Keep the commits signed. filter-branch shells out to git for every commit, and
# GIT_CONFIG_* propagates to those subprocesses where `git -c` would not.
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=gpg.ssh.program
export GIT_CONFIG_VALUE_0=/usr/bin/ssh-keygen
export GIT_CONFIG_KEY_1=user.signingkey
export GIT_CONFIG_VALUE_1="$HOME/.ssh/syness-agent-signing"
export GIT_CONFIG_KEY_2=commit.gpgsign
export GIT_CONFIG_VALUE_2=true

MSG_FILTER=$(mktemp)
cat > "$MSG_FILTER" <<'FILTER'
#!/bin/sh
msg=$(cat)
case "$msg" in
  *"untrack agent scratch files"*)
    cat <<'NEW'
Add a proper gitignore

.morse/ is deliberately not ignored wholesale: role definitions under
.morse/roles are how a project shares a cast with everyone who clones it.
Only the message store is machine-local, so the database is ignored rather
than the directory.

tmp/ and scratch/ are ignored because agent sessions write there.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
NEW
    ;;
  *) printf '%s\n' "$msg" ;;
esac
FILTER
chmod +x "$MSG_FILTER"

FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -r --cached --ignore-unmatch -q tmp/' \
  --msg-filter "$MSG_FILTER" \
  --commit-filter 'git commit-tree -S "$@"' \
  "${BASE}..HEAD"

rm -f "$MSG_FILTER"

echo
echo "Done. Verify before pushing:"
echo "  git log --oneline --stat | grep -c tmp/     # expect 0"
echo "  git log --show-signature -1                 # expect a good signature"
echo "  npm test"
echo
echo "Then drop the backup and the objects it keeps alive:"
echo "  git tag -d backup-pre-rewrite"
echo "  git reflog expire --expire=now --all && git gc --prune=now --aggressive"
echo
echo "Only then: git push origin main"
