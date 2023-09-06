const fs = require('fs');
const FormData = require('form-data');
const { default: axios } = require('axios');

const EXTENSION_TYPE = {
    'md': 'markdown'
}

async function post(utils, context) {
    const axiosInstance = await buildRequest(utils, context);
    let res = await axiosInstance.get('https://www.yuque.com/api/mine/book_stacks')
    context.groups = res.data.data;

    for (let entity of context.entitys) {
        if (!support(entity)) {
            console.log('非markdown文件,跳过');
            return;
        }
        console.log(`即将处理：${entity.relativePath}`);
        const skip = await utils.prompts({
            type: 'toggle',
            name: 'yes',
            message: '是否跳过: ',
            active: '是',
            inactive: '否'
        });
        if (skip.yes) {
            continue;
        }

        if (entity.flag === 'c') {
            await create(utils, context, entity, axiosInstance);
        } else if (entity.flag === 'u') {
            await update(utils, context, entity, axiosInstance);
        }
    }

}

async function create(utils, context, entity, axiosInstance) {

    if (context.getSyncRecords()[entity.relativePath]) {
        return update(utils, context, entity, axiosInstance);
    }

    console.log(`=====> 准备新增文章：${entity.relativePath}`);

    try {

        const params = await utils.prompts([{
            type: 'text',
            name: 'title',
            message: '标题(必填): ',
            initial: utils.extractMarkdownTitle(entity.content),
            validate: value => value.trim().length > 0
        }, {
            type: 'select',
            name: 'group',
            message: '选择分组: ',
            choices: context.groups.map(item => {
                return { title: item.name, value: item, disabled: item.books.length === 0 };
            })
        }, {
            type: 'select',
            name: 'lib',
            message: '选择知识库: ',
            choices: group => {
                return group.books.map(item => {
                    return { title: item.name, value: item }
                })
            }
        }]);

        const parentDirectory = await chooseDirectory(utils, context, params.lib, axiosInstance);

        const form = new FormData();
        if (parentDirectory) {
            form.append('create_from', 'doc_toc');
            form.append('toc_node_url', parentDirectory.url);
            form.append('toc_node_title', parentDirectory.title);
            form.append('target_uuid', parentDirectory.uuid);
            form.append('toc_node_uuid', parentDirectory.uuid);
        }

        form.append('insert_to_catalog', 'true');
        form.append('action', 'prependChild');
        form.append('type', EXTENSION_TYPE[entity.extension]);
        form.append('import_type', 'create');
        form.append('options', '{"enableLatex":1}');
        form.append('book_id', params.lib.id);
        form.append('filename', 'file');
        form.append('file', fs.createReadStream(entity.absolutePath), `${params.title}.${entity.extension}`);

        let res = await axiosInstance.post('https://www.yuque.com/api/import', form)
        context.getSyncRecords()[entity.relativePath] = { docId: res.data.data.id, bookId: params.lib.id };
        context.flushSyncRecords();
    } catch (err) {
        console.log(`break, error: ${err.message}`);
    }

}

async function update(utils, context, entity, axiosInstance) {
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
            return create(utils, context, entity, axiosInstance);
        }
        console.log(`break, reason: no sync record`);
        return;
    }

    try {

        let res = await axiosInstance.get(`https://www.yuque.com/api/docs/${id.docId}?book_id=${id.bookId}`)
        const lastVersion = res.data.data.draft_version;
        //convert
        res = await axiosInstance.post('https://www.yuque.com/api/docs/convert', {
            'to': 'lake',
            'content': entity.content,
            'from': EXTENSION_TYPE[entity.extension],
        }, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        })

        const convertContent = res.data.data.content;
        res = await axiosInstance.put(`https://www.yuque.com/api/docs/${id.docId}/content`, {
            body: convertContent,
            body_asl: convertContent,
            draft_version: lastVersion,
            edit_type: 'lake',
            format: 'lake',
            save_type: 'user'
        })
    } catch (err) {
        console.log('break, update article error: ' + err.message);
    }
}

async function buildRequest(utils, context) {

    const cookie = context.implConfig['Cookie'] || '';
    const csrfToken = cookie.match(/yuque_ctoken=(\S+);/)[1];
    const axiosInstance = utils.axios.create({
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
            'Origin': ' https://www.yuque.com',
            'Referer': ' https://www.yuque.com/',
            'Cookie': cookie,
            'X-Csrf-Token': csrfToken
        }
    });
    try {
        let res = await axiosInstance.get('https://www.yuque.com/api/mine')
        context.loginUserInfo = res.data.data;
        console.log(`当前登录用户: ${context.loginUserInfo.name}`);
        return axiosInstance;
    } catch (error) {
        if (error.response.status === 401) {
            return inquireReConfig(utils, context);
        }
        throw error;
    }
}

async function configure(utils, implConfig) {
    return utils.prompts([{
        type: 'text',
        name: 'Cookie',
        message: 'Cookie: ',
    }])
}

async function chooseDirectory(utils, context, lib, axiosInstance) {
    if (!lib.$$directory) {
        const libPageUrl = `https://www.yuque.com/${context.loginUserInfo.login}/${lib.slug}`;
        let res = await axiosInstance.get(libPageUrl);
        const jsonMatch = res.data.match(/window\.appData = JSON\.parse\(decodeURIComponent\(\"(\S+)\"\)\);/);
        const appData = JSON.parse(decodeURIComponent(jsonMatch[1]));
        const directory = [];
        for (let item of appData.book.toc) {
            if (item.parent_uuid === '') {
                directory.push(item);
                continue;
            }
            let parent = appData.book.toc.find(doc => doc.uuid === item.parent_uuid);
            if (!parent.$$children) {
                parent.$$children = [];
            }
            parent.$$children.push(item);
            item.$$parent = parent;
        }
        lib.$$directory = directory;
    }

    let intoDirectory = null;

    if (lib.$$directory.length > 0) {
        const fixedOptions = [
            { title: '🔙 返回上级目录', value: -1 },
            { title: '✔ 使用当前目录', value: 0 }
        ];

        let topChoices = [fixedOptions[1]].concat(lib.$$directory.map(item => {
            return { title: item.title, value: item };
        }));

        while (true) {
            let choose = await utils.prompts({
                type: 'select',
                name: 'dir',
                message: '选择目录: ',
                choices: () => {
                    if (!intoDirectory) {
                        return topChoices;
                    }
                    if (intoDirectory.$$choices) {
                        return intoDirectory.$$choices;
                    }
                    if (!intoDirectory.$$children || intoDirectory.$$children.length === 0) {
                        intoDirectory.$$choices = fixedOptions;
                    } else {
                        intoDirectory.$$choices = fixedOptions.concat(intoDirectory.$$children.map(item => {
                            return { title: item.title, value: item };
                        }));;
                    }
                    return intoDirectory.$$choices;
                }
            })

            if (choose.dir === 0) {
                break;
            }
            intoDirectory = (choose.dir === -1 ? intoDirectory.$$parent : choose.dir);
        }
    }

    return intoDirectory;

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
module.exports = { post, configure }