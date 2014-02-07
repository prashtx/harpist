# Harpist
Harpist is a web service that receives GitHub WebHooks and recompiles your Harp site.

Harpist will trash your `gh-pages` branch and then create a new one with the compiled site. Who knows *what* could go wrong?!

## Usage
Deploy Harpist somewhere and set the `GITHUB_TOKEN` environment variable to an [access token](https://help.github.com/articles/creating-an-access-token-for-command-line-use) you've created, and then configure your repo on GitHub with a WebHook URL along the following lines:

```
http://my-awesome-harpist-service.com/_api/hooks/harp/gh-pages/master
```

Harpist will pay attention to the branch specified at the end of that URL. Right now it always builds to gh-pages, though.

Probably it'll work!
