#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const ora = require('ora');
const simpleGit = require("simple-git");
const program = require('commander');
const prompts = require('prompts');
const marked = require('marked');
const micromatch = require('micromatch');
const axios = require('axios');

const repoPath = process.cwd();
const userHomeDir = os.homedir();
const configFolderPath = path.join(userHomeDir, '.sync-post-commit');
const configPath = path.join(configFolderPath, 'config.json');
const utils = { fileExists, removeBlankItem, extractMarkdownTitle, getPureDateTime, axios, ora, prompts, marked }


const INTERNAL_MODULE = {
    'halo1': {
        path: './halo1-impl',
        description: '默认值, 适用于halo 1.x 版本'
    },
    'csdn': {
        path: './csdn-impl'
    }
}

program.version('1.0.0');
program.command('commit <message>')
    .description('提交所有更改到git前同步做额外处理')
    .action(async (args) => {
        const repo = simpleGit(repoPath);
        const isRepo = await repo.checkIsRepo()
        if (!isRepo) {
            console.error("current folder not a git repository");
            return;
        }
        await commit(args, repo);
    });

program.command('config')
    .description('初始化配置')
    .action(async () => {
        initConfig(false);
    });

/**
 * 执行commit逻辑
 * @param {string} message 提交消息
 * @param {any} repo 存储库实例
 * @returns void
 */
async function commit(message, repo) {
    const config = getConfig();

    const implModule = postImplSelector(config);

    const status = await repo.status();

    if (status.files.length < 1) {
        console.log('no files have been changed');
        return;
    }

    let added = [];
    if (status.not_added.length > 0) {
        const addStrategy = await prompts({
            type: 'select',
            name: 'strategy',
            message: `有 ${status.not_added.length} 个文件未跟踪: `,
            choices: [
                { title: '全部', value: '0', description: 'git add ./*' },
                { title: '自定义', value: '1', description: '选择要add的文件(文件数需<=20)', disabled: status.not_added.length > 20 },
                { title: '忽略', value: '2', description: '忽略未跟踪的文件' },
                { title: '退出', value: '3', description: '结束程序,自己处理后再运行' },
            ]
        })

        switch (addStrategy.strategy) {
            case '0': {
                repo.add('./*');
                added = status.not_added;
                break;
            }
            case '1': {
                const select = await prompts({
                    type: 'multiselect',
                    name: 'files',
                    message: `选择文件: `,
                    choices: status.not_added.map(item => {
                        return { value: item };
                    })
                })
                repo.add(select.files);
                added = select.files;
                break;
            }
            case '3': {
                return;
            }
        }
    }


    let fileCount = 0;

    const created = added.concat(status.created)
        .filter(p => pathFilter(p, config))
        .map(p => {
            fileCount++;
            return buildEntity(p, 'c');
        })

    const updated = status.modified
        .filter(p => pathFilter(p, config))
        .map(p => {
            fileCount++;
            return buildEntity(p, 'u');
        })

    const deleted = status.deleted
        .filter(p => pathFilter(p, config))
        .map(p => {
            fileCount++;
            return buildEntity(p, 'd');
        })

    if (fileCount < 1) {
        console.log('no files to process');
        return;
    }

    console.log(`文件总数：${fileCount}`);


    if (!config[config.postImpl]) {
        config[config.postImpl] = {};
    }

    const entitys = [].concat(created, updated, deleted)

    await implModule.post(utils, buildContext(config, config.postImpl, fileCount, entitys));

    ///repo.commit(message);

    const push = await prompts({
        type: 'toggle',
        name: 'yes',
        message: '全部文件处理完毕,是否执行git push: ',
        active: '是',
        inactive: '否'
    })

    if (push.yes) {
        repo.push();
    }

}

/**
 *  初始化配置
 * @returns void
 */
async function initConfig(firstInit) {
    if (!fileExists(configFolderPath)) {
        fs.mkdirSync(configFolderPath);
    }

    let config = {};

    if (fileExists(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, { encoding: 'utf8' }));
        if (firstInit) {
            return;
        }
    }

    let implChoices = Object.keys(INTERNAL_MODULE).map(m => {
        return { title: m, value: m, description: m.description || '' }
    })

    implChoices.push({ title: '自定义', value: '0', description: '自定义提交实现' });

    let postImpl = await prompts([{
        type: 'select',
        name: 'name',
        message: '选择上传实现：',
        choices: implChoices
    }, {
        type: prev => prev === '0' ? 'text' : null,
        name: 'name',
        message: '定义实现名称：'
    }, {
        type: prev => INTERNAL_MODULE[prev] ? null : 'text',
        name: 'modulePath',
        message: '实现模块文件磁盘路径：'
    }]);

    config.postImpl = postImpl.name;

    let implModule;
    if (INTERNAL_MODULE[postImpl.name]) {
        implModule = require(INTERNAL_MODULE[postImpl.name].path);
    } else {
        console.log(postImpl);
        implModule = require(postImpl.modulePath);
    }


    if (implModule.configure) {
        config[postImpl.name] = await implModule.configure(utils, config[postImpl.name]);
    }

    if (!config[postImpl.name]) {
        config[postImpl.name] = {};
    }

    config[postImpl.name].modulePath = postImpl.modulePath;


    let mode = 'disable';

    config.filter = await prompts([
        {
            type: 'select',
            name: 'mode',
            message: '选择过滤模式: ',
            choices: [
                { title: 'disable', value: 'disable', description: '禁用' },
                { title: 'extension', value: 's', description: '符合的文件后缀名' },
                { title: 'include', value: 'i', description: '符合的文件路径' },
                { title: 'exclude', value: 'e', description: '排除的文件路径' },
                { title: 'extension + include', value: 'si', description: '后缀+包含文件路径组合过滤' },
                { title: 'extension + exclude', value: 'se', description: '后缀+排除文件路径组合过滤' },
            ]
        }, {
            type: prev => {
                mode = prev;
                return (prev !== 'disable' && prev.includes('s')) ? 'list' : null;
            },
            name: 'extension',
            initial: (config.filter && config.filter.extension) ? config.filter.extension.join(',') : 'md',
            message: '文件后缀,示例: md,html',
            format: removeBlankItem
        }, {
            type: prev => {
                if (mode === 'disable') {
                    return null;
                }
                return (mode.includes('i') || mode.includes('e')) ? 'list' : null;
            },
            name: prev => mode.includes('i') ? 'include' : 'exclude',
            initial: prev => {
                if (mode.includes('i')) {
                    return (config.filter && config.filter.include) ? config.filter.include.join(',') : '';
                }
                if (mode.includes('e')) {
                    return (config.filter && config.filter.exclude) ? config.filter.exclude.join(',') : '';
                }
            },
            message: '要过滤的文件，示例：**/_sidebar.md,/README.md',
            format: removeBlankItem
        },
    ]);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * 选择推送实现
 * @param {object} config 配置 
 * @returns any
 */
function postImplSelector(config) {
    if (INTERNAL_MODULE[config.postImpl]) {
        return require(INTERNAL_MODULE[config.postImpl].path);
    }
    return require(config[config.postImpl].modulePath);
}

/**
 * 构建context
 * @param {object} config 配置
 * @param {string} postImpl 实现名称
 * @returns 
 */
function buildContext(config, postImpl, fileCount, entitys) {
    return {
        config,
        implConfig: config[postImpl],
        configFolderPath,
        repoPath,
        fileCount,
        entitys,
        syncRecordsFilePath: path.join(repoPath, `.${postImpl}-sync.json`),
        refreshConfig: function () {
            fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
        },
        getSyncRecords: function () {
            if (this.syncRecords) {
                return this.syncRecords;
            }

            if (fileExists(this.syncRecordsFilePath)) {
                this.syncRecords = JSON.parse(fs.readFileSync(this.syncRecordsFilePath, { encoding: 'utf8' }));
            } else {
                this.syncRecords = {};
            }
            return this.syncRecords;
        },
        flushSyncRecords: function () {
            fs.writeFileSync(this.syncRecordsFilePath, JSON.stringify(this.syncRecords), { encoding: 'utf8' })
        }
    }

}

/**
 * 构建entity
 * @param {string} relativePath 相对于储存库的地址
 * @param {string} flag 文件状态标识：c:创建,u:更新,d:删除
 * @returns object
 */
function buildEntity(relativePath, flag) {
    const absolutePath = path.join(repoPath, relativePath)
    const content = fs.readFileSync(absolutePath, { encoding: 'utf8' });
    return {
        flag,
        content,
        relativePath,
        absolutePath
    };
}

function pathFilter(p, config) {

    // i：include，e：exclude，s：extension
    if (!config.filter || config.filter.mode === 'disable') {
        return true;
    }

    let mode = config.filter.mode;

    if (mode.includes('s') && Array.isArray(config.filter.extension) && config.filter.extension.length > 0) {
        if (!config.filter.extension.some(ex => p.endsWith('.' + config.filter.extension))) {
            return false;
        }
    }

    if (mode.includes('i') && Array.isArray(config.filter.include) && config.filter.include.length > 0) {
        return micromatch.isMatch(p, config.filter.include)
    }

    if (mode.includes('e') && Array.isArray(config.filter.exclude) && config.filter.exclude.length > 0) {
        return !micromatch.isMatch(p, config.filter.exclude)
    }

    return true;
}

function getConfig() {
    return JSON.parse(fs.readFileSync(configPath, { encoding: 'utf8' }));
}

function fileExists(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.F_OK)
        return true;
    } catch (err) {
        return false;
    }
}

function removeBlankItem(stringArray) {
    return stringArray.filter(i => (typeof i) === 'string' && i.trim().length > 0);
}

function extractMarkdownTitle(content) {
    let [firstLine] = content.trim().split('\n', 2);
    const match = firstLine.trim().match(/#*(.*)/);
    return match[1].trim();
}

function getPureDateTime() {
    const date = new Date();
    const yyyy = date.getFullYear();
    const MM = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    const HH = date.getHours().toString().padStart(2, '0');
    const mm = date.getMinutes().toString().padStart(2, '0');
    const ss = date.getSeconds().toString().padStart(2, '0');
    return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
}

(async () => {
    if (process.argv[2] !== 'config') {
        await initConfig(true);
    }
    program.parse(process.argv);
})();