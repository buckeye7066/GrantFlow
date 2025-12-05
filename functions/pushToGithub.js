import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';

const GITHUB_API = 'https://api.github.com';

createSafeServer(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { repo, branch = 'main', files, commitMessage = 'Code review submission', createPR = false, prTitle, prBody } = body;

    if (!repo || !files || !Array.isArray(files) || files.length === 0) {
      return Response.json({ error: 'Missing required fields: repo and files array' }, { status: 400 });
    }

    const token = Deno.env.get('GITHUB_TOKEN');
    if (!token) {
      return Response.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });
    }

    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    const refResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/ref/heads/' + branch, { headers });
    
    let latestCommitSha = null;
    let baseTreeSha = null;
    let isEmptyRepo = false;
    
    if (!refResponse.ok) {
      const errorText = await refResponse.text();
      if (errorText.includes('Git Repository is empty') || refResponse.status === 409) {
        isEmptyRepo = true;
      } else {
        return Response.json({ error: 'Failed to get branch ref: ' + errorText }, { status: refResponse.status });
      }
    } else {
      const refData = await refResponse.json();
      latestCommitSha = refData.object.sha;
      const commitResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/commits/' + latestCommitSha, { headers });
      const commitData = await commitResponse.json();
      baseTreeSha = commitData.tree.sha;
    }

    const treeItems = [];
    for (const file of files) {
      const blobResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/blobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' })
      });
      
      if (!blobResponse.ok) {
        const error = await blobResponse.text();
        return Response.json({ error: 'Failed to create blob for ' + file.path + ': ' + error }, { status: blobResponse.status });
      }
      
      const blobData = await blobResponse.json();
      treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobData.sha });
    }

    const treePayload = { tree: treeItems };
    if (baseTreeSha) treePayload.base_tree = baseTreeSha;
    
    const treeResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/trees', {
      method: 'POST',
      headers,
      body: JSON.stringify(treePayload)
    });
    
    if (!treeResponse.ok) {
      const error = await treeResponse.text();
      return Response.json({ error: 'Failed to create tree: ' + error }, { status: treeResponse.status });
    }
    
    const treeData = await treeResponse.json();
    const targetBranch = createPR ? 'review-' + Date.now() : branch;

    if (createPR) {
      const createBranchResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/refs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref: 'refs/heads/' + targetBranch, sha: latestCommitSha })
      });
      
      if (!createBranchResponse.ok) {
        const error = await createBranchResponse.text();
        return Response.json({ error: 'Failed to create branch: ' + error }, { status: createBranchResponse.status });
      }
    }

    const commitPayload = { message: commitMessage, tree: treeData.sha };
    commitPayload.parents = latestCommitSha ? [latestCommitSha] : [];
    
    const newCommitResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/commits', {
      method: 'POST',
      headers,
      body: JSON.stringify(commitPayload)
    });
    
    if (!newCommitResponse.ok) {
      const error = await newCommitResponse.text();
      return Response.json({ error: 'Failed to create commit: ' + error }, { status: newCommitResponse.status });
    }
    
    const newCommitData = await newCommitResponse.json();

    let updateRefResponse;
    if (isEmptyRepo) {
      updateRefResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/refs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref: 'refs/heads/' + targetBranch, sha: newCommitData.sha })
      });
    } else {
      updateRefResponse = await fetch(GITHUB_API + '/repos/' + repo + '/git/refs/heads/' + targetBranch, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sha: newCommitData.sha })
      });
    }
    
    if (!updateRefResponse.ok) {
      const error = await updateRefResponse.text();
      return Response.json({ error: 'Failed to update ref: ' + error }, { status: updateRefResponse.status });
    }

    const result = {
      success: true,
      commitSha: newCommitData.sha,
      branch: targetBranch,
      filesUpdated: files.map(f => f.path),
      commitUrl: 'https://github.com/' + repo + '/commit/' + newCommitData.sha
    };

    if (createPR) {
      const prResponse = await fetch(GITHUB_API + '/repos/' + repo + '/pulls', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: prTitle || commitMessage,
          body: prBody || 'Code review submission',
          head: targetBranch,
          base: branch
        })
      });
      
      if (prResponse.ok) {
        const prData = await prResponse.json();
        result.pullRequest = { number: prData.number, url: prData.html_url };
      }
    }

    return Response.json(result);

  } catch (error) {
    console.error('[pushToGithub] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});