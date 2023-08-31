const crypto = require('crypto');

const CONTEN_MANAGE_CA_KEY = '203803574';
const CONTEN_MANAGE_CA_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba';
const USER_INFO_URL = 'https://bizapi.csdn.net/blog-console-api/v1/user/info';
const SAVE_ARTICLE_URL = 'https://bizapi.csdn.net/blog-console-api/v1/postedit/saveArticle';

async function post(utils, context) {

    const axiosInstance = await buildRequest(utils, context);

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


async function create(utils, context, entity, axiosInstance) {

    console.log(context.getSyncRecords());
    if (context.getSyncRecords()[entity.relativePath]) {
        return update(utils, context, entity, axiosInstance);
    }

    console.log(`=====> 准备新增文章：${entity.relativePath}`);
    const params = await utils.prompts([
        {
            type: 'text',
            name: 'title',
            message: '文章标题(必填): ',
            validate: value => value.trim().length > 0
        },
        {
            type: 'select',
            name: 'type',
            message: '文章类型: ',
            choices: [
                { title: '原创', value: 'original' },
                { title: '转载', value: 'repost', disabled: true },
                { title: '翻译', value: 'translated', disabled: true }
            ]
        },
        {
            type: 'text',
            name: 'categories',
            message: '分类(多个使用,号隔开): '
        }, {
            type: 'text',
            name: 'tags',
            message: '标签(必填,多个使用,号隔开): ',
            validate: value => value.trim().length > 0
        }, {
            type: 'select',
            name: 'read_type',
            message: '可见范围: ',
            choices: [
                { title: '全部可见', value: 'public' },
                { title: '仅我可见', value: 'private' },
                { title: '粉丝可见', value: 'read_need_fans' },
                { title: 'VIP可见', value: 'read_need_vip' }
            ]
        }, {
            type: 'text',
            name: 'description',
            message: '文章摘要'
        }
    ]);
    params.source = 'pc_postedit';
    params.status = '0';
    params.markdowncontent = entity.content;
    params.content = utils.marked.parse(entity.content);

    try {
        let res = await axiosInstance.post(SAVE_ARTICLE_URL, params, {
            headers: {
                'X-Ca-Key': CONTEN_MANAGE_CA_KEY,
                'X-Ca-Signature': get_x_ca_signature(SAVE_ARTICLE_URL, 'POST', CONTEN_MANAGE_CA_KEY, context.caNonce,
                    CONTEN_MANAGE_CA_SECRET, 'application/json')
            }
        });

        context.getSyncRecords()[entity.relativePath] = res.data.data.article_id;
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
    const url = 'https://bizapi.csdn.net/blog-console-api/v1/editor/getArticle?id=' + id;

    try {
        let res = await axiosInstance.get(url, {
            headers: {
                'X-Ca-Key': CONTEN_MANAGE_CA_KEY,
                'X-Ca-Signature': get_x_ca_signature(url, 'GET', CONTEN_MANAGE_CA_KEY, context.caNonce, CONTEN_MANAGE_CA_SECRET)
            }
        })
        let params = res.data.data;
        params.markdowncontent = entity.content;
        params.content = utils.marked.parse(entity.content);
        params.is_new = 1;
        await axiosInstance.post(SAVE_ARTICLE_URL, params, {
            headers: {
                'X-Ca-Key': CONTEN_MANAGE_CA_KEY,
                'X-Ca-Signature': get_x_ca_signature(SAVE_ARTICLE_URL, 'POST', CONTEN_MANAGE_CA_KEY, context.caNonce,
                    CONTEN_MANAGE_CA_SECRET, 'application/json')
            }
        });
    } catch (err) {
        console.log('break, update article error: ' + err.message);
    }
}

async function buildRequest(utils, context) {
    context.caNonce = gen_x_ca_nonce();

    const axiosInstance = utils.axios.create({
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
            'Origin': 'https://i.csdn.net',
            'Referer': 'https://i.csdn.net/',
            'X-Ca-Signature-Headers': 'x-ca-key,x-ca-nonce',
            'X-Ca-Nonce': context.caNonce,
            'Cookie': context.implConfig['Cookie'],
        }
    });

    try {
        let res = await axiosInstance.get(USER_INFO_URL, {
            headers: {
                'X-Ca-Key': CONTEN_MANAGE_CA_KEY,
                'X-Ca-Signature': get_x_ca_signature(USER_INFO_URL, 'GET', CONTEN_MANAGE_CA_KEY, context.caNonce, CONTEN_MANAGE_CA_SECRET)
            }
        })
        if (res.data.code === 40001) {
            return inquireReConfig(utils, context);
        }
        console.log(`当前登录用户: ${res.data.data.nickname}`);
        return axiosInstance;
    } catch (error) {
        console.log(error);
        if (error.response.status === 401) {
            return inquireReConfig(utils, context);
        }
        throw error;
    }
}

function gen_x_ca_nonce() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (function (e) {
        var t = 16 * Math.random() | 0
            , n = "x" === e ? t : 3 & t | 8;
        return n.toString(16)
    }))
}

function get_x_ca_signature(url, method, caKey, caNonce, secret, contentType) {
    url = url.substring(url.indexOf('//') + 2);
    url = url.substring(url.indexOf('/'));
    let data;
    if ("GET" === method) {
        data = `GET\napplication/json, text/plain, */*\n\n\n\nx-ca-key:${caKey}\nx-ca-nonce:${caNonce}\n${url}`
    } else {
        url = url.split("\?")[0];
        data = `POST\napplication/json, text/plain, */*\n\n${contentType}\n\nx-ca-key:${caKey}\nx-ca-nonce:${caNonce}\n${url}`
    }

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(data);
    return hmac.digest('base64');
}

async function configure(utils, implConfig) {
    return utils.prompts([{
        type: 'text',
        name: 'Cookie',
        message: 'Cookie: ',
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

module.exports = { post, configure }