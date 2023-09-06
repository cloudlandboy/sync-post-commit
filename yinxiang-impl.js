const he = require('he');
const css = require('css');
const path = require('path');
const cheerio = require('cheerio');
const hljs = require('highlight.js');
const Evernote = require('evernote');
const { readFileSync } = require('fs');

const EXTENSION_TYPE = {
    'md': 'markdown'
}

async function post(utils, context) {


    const highlightCss = readFileSync(path.join(__dirname, 'css/highlight-atom-one-dark.min.css'), { encoding: 'utf8' })
    const styleRules = css.parse(highlightCss).stylesheet.rules;

    // assuming that the longer the selector, the higher the level 
    context.sortedStyle = [];
    for (let rule of styleRules) {
        let css = {};
        for (let decr of rule.declarations) {
            css[decr.property] = decr.value;
        }
        for (const selector of rule.selectors) {
            context.sortedStyle.push({ selector: selector, css });
        }
    }
    context.sortedStyle.sort((a, b) => a.selector.length - b.selector.length);
    const originalRenderer = new utils.marked.Renderer()
    const renderer = new utils.marked.Renderer();
    const marked = new utils.marked.Marked();
    marked.setOptions({
        renderer: renderer
    });

    renderer.table = function (header, body) {
        const tableHtml = originalRenderer.table(header, body);
        const openTag = tableHtml.substring(0, 6);
        return openTag + ' style="border-collapse: collapse; min-width: 100%;margin-bottom: 14px;"' + tableHtml.substring(6);;
    }

    renderer.tablecell = function (content, flags) {
        const cellHtml = originalRenderer.tablecell(content, flags);
        const openTag = cellHtml.substring(0, 3);
        return openTag + ' style="padding: 8px; border: 1px solid;"' + cellHtml.substring(3);
    }


    renderer.checkbox = function (checked) {
        return `<span style="display: inline-block;vertical-align: middle;width: 16px;height: 16px;line-height: 16px;text-align:center;color: green;border: 1px solid #888;border-radius: 2px;margin-right: 5px;position: relative;">${checked ? '✔' : ''}</span>`;
    }

    renderer.listitem = function (text, task, checked) {
        return `<li style="margin-bottom: 0.4em;">${text}</li>`;
    }

    renderer.codespan = function (code) {
        return `<code style="color: #476582;padding: .25rem .5rem;margin: 0;font-size: .85em;background-color: rgba(27,31,35,.05);border-radius: 3px;">${code}</code>`
    }

    renderer.code = function (code, infostring, escaped) {
        // code = code.replace(/\s/g, '&nbsp;');
        const lang = (infostring || '').trim();
        if (lang) {
            code = hljs.highlight(code, { language: lang }).value;
        }
        const $ = cheerio.load(`<pre style="white-space: pre-wrap;"><code class="hljs" style="color: red">${code}</code></pre>`);
        for (const style of context.sortedStyle) {
            $(style.selector).css(style.css)
        }

        $('*').removeAttr('class');
        return $('body').html();
    };

    renderer.image = function (src, title, text) {
        return `<img src="${src}" alt="${text}"></img>`;
    }
    utils = Object.assign({}, utils);
    utils.marked = marked;

    const noteStore = await buildNoteStore(utils, context);
    for (let entity of context.entitys) {
        if (entity.flag === 'c') {
            await create(utils, context, entity, noteStore);
        } else if (entity.flag === 'u') {
            await update(utils, context, entity, noteStore);
        }
    }

}

async function create(utils, context, entity, noteStore) {

    if (context.getSyncRecords()[entity.relativePath]) {
        return update(utils, context, entity, noteStore);
    }

    console.log(`=====> 准备新增文章：${entity.relativePath}`);

    try {
        const params = await utils.prompts([{
            type: 'select',
            name: 'notebook',
            message: '选择笔记本: ',
            choices: context.notebooks.map(item => {
                return {
                    title: item.name,
                    value: item
                }
            })
        }, {
            type: 'text',
            name: 'title',
            message: '笔记标题: ',
            initial: utils.extractMarkdownTitle(entity.content),
            validate: value => value.trim().length > 0
        }])

        let html = utils.marked.parse(entity.content);
        let note = buildNote(params.title, html, params.notebook);
        note = await noteStore.createNote(note);
        context.getSyncRecords()[entity.relativePath] = note.guid;
        context.flushSyncRecords();
    } catch (err) {
        console.log(`break, error: ${err.message}`);
    }

}

async function update(utils, context, entity, noteStore) {
    console.log(`=====> 准备更新文章：${entity.relativePath}`);

    const id = context.getSyncRecords()[entity.relativePath];
    if (!id) {
        const toCreate = await utils.prompts({
            type: 'toggle',
            name: 'yes',
            message: `该文件没有同步记录, 是否转为创建`,
            active: '是',
            inactive: '否'
        })

        if (toCreate.yes) {
            return create(utils, context, entity, noteStore);
        }
        console.log(`break, reason: no sync record`);
        return;
    }

    try {
        const html = utils.marked.parse(entity.content);
        let note = await noteStore.getNote(id, true, false, false, false);
        note = buildNote(note.title, html, { guid: note.notebookGuid });
        note.guid = id;
        await noteStore.updateNote(note);
    } catch (err) {
        console.log('break, update article error: ' + err.message);
    }
}

async function buildNoteStore(utils, context) {
    const spinner = utils.ora('检查token').start();
    try {
        const client = new Evernote.Client({ token: context.implConfig.token, sandbox: false });
        const noteStore = client.getNoteStore(context.implConfig.noteStoreUrl);
        context.notebooks = await noteStore.listNotebooks();
        spinner.stop();
        return noteStore;
    } catch (err) {
        spinner.stop();
        return inquireReConfig(utils, context);
    }

}

async function configure(utils, implConfig) {
    return utils.prompts([{
        type: 'text',
        name: 'token',
        message: 'Token (https://app.yinxiang.com/api/DeveloperToken.action): ',
        validate: value => value.trim().length > 0
    }, {
        type: 'text',
        name: 'noteStoreUrl',
        message: 'NoteStore URL: ',
        validate: value => value.trim().length > 0
    }])
}

async function inquireReConfig(utils, context) {
    const reConfig = await utils.prompts({
        type: 'toggle',
        name: 'yes',
        message: `登录失效, 是否重新配置: `,
        active: '是',
        inactive: '否'
    })

    if (reConfig.yes) {
        let authInfo = await configure(utils, context.implConfig);
        Object.assign(context.implConfig, authInfo);
        context.refreshConfig();
        return buildRequest(utils, context);
    }

    throw new Error('login invalid');
}

function support(entity) {
    return !!EXTENSION_TYPE[entity.extension];
}

function buildNote(noteTitle, noteBody, parentNotebook) {

    var nBody = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
    nBody += "<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\">";
    nBody += "<en-note>" + noteBody + "</en-note>";
    var ourNote = new Evernote.Types.Note();
    ourNote.title = noteTitle;
    ourNote.content = nBody;
    ourNote.attributes = new Evernote.Types.NoteAttributes({ contentClass: 'cn.clboy.markdown' });

    if (parentNotebook && parentNotebook.guid) {
        ourNote.notebookGuid = parentNotebook.guid;
    }

    return ourNote;

}

module.exports = { post, configure }