const fs = require('fs');
const path = require('path');

/**
 * 
 * @param {object} utils 工具
 * @param {object} context 上下文
 */
async function post(utils, context) {

    const axiosInstance = await buildRequest(utils, context)

    context.prepareDataGet = prepareData(axiosInstance);
    context.prepareDataGet.then(data => {
        context.prepareData = data;
    });

    for (let entity of context.entitys) {
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

async function configure(utils, implConfig) {
    return utils.prompts([{
        type: 'text',
        name: 'baseUrl',
        initial: implConfig ? implConfig.baseUrl : null,
        message: '设置api的baseUrl(https://example.com/api/admin): ',
    }])
}

async function create(utils, context, entity, axiosInstance) {
    if (context.getSyncRecords()[entity.relativePath]) {
        return update(utils, context, entity, axiosInstance);
    }

    if (!context.unify) {
        context.unify = await utils.prompts({
            type: 'toggle',
            name: 'enable',
            message: '创建时是否为所有文章使用统一参数(分类、标签): ',
            active: '是',
            inactive: '否'
        })
    }

    await Promise.all([context.prepareDataGet]);

    console.log(`=====> 准备创建文章：${entity.relativePath}`);

    let params = await utils.prompts([{
        type: 'text',
        name: 'title',
        message: '文章标题(必填): ',
        initial: utils.extractMarkdownTitle(entity.content)
    }, {
        type: 'text',
        name: 'slug',
        message: '文章别名(必填): ',
        initial: utils.getPureDateTime()
    }, {
        type: 'text',
        name: 'summary',
        message: '摘要: '
    }]);

    let maybeUnifyParams = await getMaybeUnifyParams(utils, context);
    Object.assign(params, maybeUnifyParams);

    params.content = utils.marked.parse(entity.content);
    params.originalContent = entity.content;

    try {
        const res = await axiosInstance.post('/posts', params)
        const id = res.data.data.id;
        const syncRecords = context.getSyncRecords();
        syncRecords[entity.relativePath] = id;
        context.flushSyncRecords();
    } catch (err) {
        console.log(`break, error: ${err.message}`);
    }
}

async function update(utils, context, entity, axiosInstance) {
    const syncRecords = context.getSyncRecords();

    console.log(`=====> 准备更新文章：${entity.relativePath}`);

    const id = syncRecords[entity.relativePath];

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
        const res = await axiosInstance.get(`/posts/${id}`);
        const data = res.data.data;
        data.content = utils.marked.parse(entity.content);
        data.originalContent = entity.content;
        return axiosInstance.put(`/posts/${id}`, data)
    } catch (err) {
        console.log(`break, error: ${err.message}`);
    }



}

async function buildRequest(utils, context) {
    return new Promise((resolve, reject) => {
        const tokenStorePath = path.join(context.configFolderPath, '.halo1-token');
        const axiosInstance = utils.axios.create({
            baseURL: context.implConfig.baseUrl,
        });

        if (utils.fileExists(tokenStorePath)) {
            let token = JSON.parse(fs.readFileSync(tokenStorePath, { encoding: 'utf8' }));
            axiosInstance.defaults.headers['Admin-Authorization'] = token.access_token;
            const spinner = utils.ora('检查登录状态').start();
            axiosInstance.get('/users/profiles').then(res => {
                //check token
                spinner.stop();
                console.log(`当前登录用户: ${res.data.data.nickname}`);
                resolve(axiosInstance);
            }).catch(err => {
                if (err.response.status === 401) {
                    //refresh token
                    spinner.text = '刷新token';
                    axiosInstance.post(`/refresh/${token.refresh_token}`).then(res => {
                        token = res.data.data;
                        axiosInstance.defaults.headers['Admin-Authorization'] = token.access_token;
                        fs.writeFileSync(tokenStorePath, JSON.stringify(token), { encoding: 'utf8' });
                        spinner.stop();
                        console.log('刷新token成功');
                        resolve(axiosInstance);
                    }).catch(err => {
                        spinner.stop();
                        login(axiosInstance, utils, tokenStorePath).then(() => resolve(axiosInstance)).catch(err => reject(err));
                    });
                } else {
                    spinner.stop();
                    reject(err);
                }
            });
        } else {
            login(axiosInstance, utils, tokenStorePath).then(() => resolve(axiosInstance)).catch(err => reject(err));
        }
    });
}

async function login(axiosInstance, utils, tokenStorePath) {
    const authInfo = await utils.prompts([{
        type: 'text',
        name: 'username',
        message: 'halo登录-用户名：',
    }, {
        type: 'password',
        name: 'password',
        message: 'halo登录-密码：',
    }]);

    const res = await axiosInstance.post('/login', authInfo);
    const token = res.data.data;
    console.log('登录成功');

    axiosInstance.defaults.headers['Admin-Authorization'] = token.access_token;
    fs.writeFileSync(tokenStorePath, JSON.stringify(token), { encoding: 'utf8' });
}

async function getMaybeUnifyParams(utils, context) {
    if (context.unify.enable && context.unify.params) {
        return context.unify.params;
    }
    let params = await utils.prompts([{
        type: 'multiselect',
        name: 'categoryIds',
        message: '分类目录: ',
        choices: context.prepareData.categories.map(item => {
            return { title: item.name, value: item.id }
        })
    }, {
        type: 'multiselect',
        name: 'tagIds',
        message: '标签: ',
        choices: context.prepareData.tags.map(item => {
            return { title: item.name, value: item.id }
        })
    }, {
        type: 'toggle',
        name: 'status',
        message: '是否发布? ',
        active: '发布',
        inactive: '保存草稿'
    }]);

    params.status = params.status ? 'PUBLISHED' : 'DRAFT'
    params.keepRaw = true;
    if (context.unify.enable) {
        context.unify.params = params;
    }

    return params;
}

async function prepareData(axiosInstance) {
    const data = {};
    let res = await axiosInstance.get('/categories?more=false');
    data.categories = res.data.data;
    res = await axiosInstance.get('/tags?sort=name%2Casc&more=true')
    data.tags = res.data.data;
    return data;
}

module.exports = { post, configure }