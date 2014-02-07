/*jslint node: true*/
'use strict';

var fs = require('fs');
var child_process = require('child_process');

var _ = require('lodash');
var express = require('express');
var Github = require('github-api');
var harp = require('harp');
var q = require('q');
var readdirp = require('readdirp');
var request = require('request');
var uuid = require('uuid');

var port = process.env.PORT || 3000;
var srcdir = process.cwd() + '/SRC';
var outdir = srcdir + '/_site';

var githubToken = process.env.GITHUB_TOKEN;

var app = express();

app.use(express.bodyParser());

var mkdir = q.denodeify(fs.mkdir);
var writeFile = q.denodeify(fs.writeFile);
var readFile = q.denodeify(fs.readFile);

function qrequest(options) {
  var deferred = q.defer();
  if (!options.headers) {
    options.headers = {};
  }
  options.headers['User-Agent'] = 'prashtx-app-harpist';
  options.qs = {
    access_token: githubToken
  };
  request(options, function (error, response, body) {
    if (error) {
      deferred.reject(error);
    } else {
      deferred.resolve({ response: response, body: body });
    }
  });
  return deferred.promise;
}

function getFile(url, location) {
  return qrequest({
    method: 'GET',
    url: url
  })
  .then(function (result) {
    if (result.response.statusCode !== 200) {
      console.log(result.body);
      throw new Error('Got status ' + result.response.statusCode + ' from Github.');
    }
    var data = JSON.parse(result.body);

    // Convert the content field from base64.
    var buf = new Buffer(data.content, 'base64');

    // Write to location
    return writeFile(location, buf);
  });
}

function clean(source, output) {
  // Remove the source directory.
  console.log('info Cleaning source directory');
  return q.nfcall(child_process.exec, 'rm -rf ' + source)
  .then(function () {
    console.log('info Cleaning output directory');
    return q.nfcall(child_process.exec, 'rm -rf ' + output);
  });
}

function download(repo, branch) {
  console.log('info Getting source from ' + branch);

  // Create a temporary directory
  var location = process.cwd() + '/' + uuid.v1();
  return mkdir(location)
  .then(function () {
    return q.ninvoke(repo, 'getTree', branch + '?recursive=true');
  })
  .then(function (data) {
    // Traverse the tree, making directories and downloading blobs
    var actions = data.map(function (item) {
      return function () {
        if (item.type === 'tree') {
          return mkdir(location + '/' + item.path);
        }
        return getFile(item.url, location + '/' + item.path);
      };
    });

    // Perform each action in sequence.
    return actions.reduce(q.when, q());
  })
  .then(function () {
    return location;
  });
}

function build(source) {
  console.log('info Building site with Harp');
  var output = source + '-OUTPUT';
  // Build with Harp
  return q.ninvoke(harp, 'compile', source, output)
  .then(function () {
    return output;
  });
}

function publish(output, repo) {
  var branch = 'gh-pages';
  var ref = 'heads/' + branch;

  var repoData;

  // Remove heads/gh-pages ref
  return q.ninvoke(repo, 'listBranches')
  .then(function (branches) {
    if (branches.indexOf(branch) !== -1) {
      console.log('info: Deleting branch ' + branch);
      return q.ninvoke(repo, 'deleteRef', ref);
    }
    return;
  })
  // Get repo information
  .then(function () {
    return q.ninvoke(repo, 'show')
    .then(function (data) {
      repoData = data;
      console.log('Publishing site to ' + repoData.name + '/' + branch);
      return 5;
    });
  })
  // Process each output file
  .then(function () {
    var deferred = q.defer();

    var tree = [];
    var files = [];
    // Traverse the build directory and create a payload
    var entryStream = readdirp({
      root: output
    })
    .on('data', function (entry) {
      // Add the entry to the payload
      if (entry.stat.isFile()) {
        var node = {
          path: entry.path,
          mode: '100644',
          type: 'blob'
        };
        tree.push(node);
        files.push({
          path: entry.fullPath,
          node: node
        });
      }
    })
    .on('end', function () {
      // Create actions that return promises. Each one reads a file, converts
      // it to base64, creates a blob on github, and places the SHA in the tree.
      var actions = files.map(function (file) {
        return function () {
          return readFile(file.path)
          .then(function (data) {
            // Create the tree
            return qrequest({
              method: 'POST',
              url: repoData.url + '/git/blobs',
              json: {
                content: data.toString('base64'),
                encoding: 'base64'
              }
            })
            .then(function (result) {
              if (result.response.statusCode !== 201) {
                console.log(result.body);
                throw new Error('Received error response from Github: ' + result.response.statusCode);
              }
              console.log('info Created blob for ' + file.node.path);
              file.node.sha = result.body.sha;
            });
          });
        };
      });

      actions.reduce(q.when, q())
      .then(function () {
        deferred.resolve(tree);
      });
    })
    .on('error', function (error) {
      deferred.reject(error);
    });

    return deferred.promise;
  })
  .then(function (tree) {
    console.log('info Creating tree on Github');

    // Create the tree
    return qrequest({
      method: 'POST',
      url: repoData.url + '/git/trees',
      json: { tree: tree }
    })
    .then(function (result) {
      if (result.response.statusCode !== 201) {
        console.log(result.body);
        throw new Error('Got status ' + result.response.statusCode + ' from Github.');
      }
      console.log('info Created tree');

      // Get the SHA of the tree we just created.
      var sha = result.body.sha;
      // Create a commit for that tree
      return qrequest({
        method: 'POST',
        url: repoData.url + '/git/commits',
        json: {
          message: 'Automated commit by Harpist',
          tree: sha,
          parents: []
        }
      });
    })
    .then(function (result) {
      if (result.response.statusCode !== 201) {
        console.log(result.body);
        throw new Error('Got status ' + result.response.statusCode + ' from Github.');
      }
      console.log('info Created commit');

      // Get the SHA of the commit we just created.
      var sha = result.body.sha;
      // Create a ref
      return qrequest({
        method: 'POST',
        url: repoData.url + '/git/refs',
        json: {
          ref: 'refs/' + ref,
          sha: sha
        }
      });
    })
    .then(function (result) {
      if (result.response.statusCode !== 201) {
        console.log(result.body);
        throw new Error('Got status ' + result.response.statusCode + ' from Github.');
      }
      console.log('info Created ref');
      return;
    });
  });
}

app.post('/_api/hooks/harp/gh-pages/:branch', function (req, res) {
  var payload = JSON.parse(req.body.payload);
  var branch = req.params.branch;
  var owner = payload.repository.owner.name;

  var commitBranch = payload.ref.split('/')[2];
  if (commitBranch !== branch) {
    // We only process commits to the branch specified in the URL.
    // Silently do nothing.
    res.send(200);
    return;
  }

  var github = new Github({
    token: githubToken,
    auth: 'oauth'
  });

  var repo = github.getRepo(owner, payload.repository.name);
  var source;
  var output;

  // Download the branch.
  download(repo, branch)
  .then(function (loc) {
    source = loc;
    // Build
    return build(source);
  })
  .then(function (out) {
    output = out;
    // Publish
    return publish(output, repo);
  })
  .then(function () {
    // Clean
    return clean(source, output);
  })
  .then(function () {
    res.send(200);
  })
  .fail(function (error) {
    console.log(error);
    res.send(500);
    throw error;
  })
  .done();
});

app.listen(port, function (error) {
  if (error) {
    throw error;
  }
  console.log('Listening on port ' + port);
});
