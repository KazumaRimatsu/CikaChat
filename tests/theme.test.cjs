/**
 * CikaChat 主题系统单元测试
 *
 * 运行方式：node tests/theme.test.js
 *
 * 覆盖范围：
 *  - 主题状态管理：导入 / 激活 / 预览 / 删除 / 持久化与重启恢复 / id 冲突处理
 *  - 样式加载逻辑：<style> 注入内容、<html> 属性写入、内置主题清空注入
 *  - 校验规则：非法主题文件、内置 id 冲突、变量命名空间白名单
 */
'use strict';

const path = require('path');

/* ============================================================
 * 最小环境 stub（document / localStorage）
 * ============================================================ */
const storageMap = {};
global.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(storageMap, k) ? storageMap[k] : null; },
    setItem(k, v) { storageMap[k] = String(v); },
    removeItem(k) { delete storageMap[k]; },
    clear() { Object.keys(storageMap).forEach(k => delete storageMap[k]); }
};

const attrs = {};
const createdElements = [];
global.document = {
    documentElement: {
        getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
        setAttribute(n, v) { attrs[n] = String(v); },
        removeAttribute(n) { delete attrs[n]; },
        hasAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n); },
        style: { removeProperty() {} }
    },
    head: {
        appendChild(el) { createdElements.push(el); }
    },
    createElement(tag) {
        const el = { tagName: tag, id: '', textContent: '', setAttribute() {}, appendChild() {} };
        createdElements.push(el);
        return el;
    }
};

require(path.join(__dirname, '..', 'src', 'theme.js'));

/* ============================================================
 * 断言与用例框架
 * ============================================================ */
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  PASS  ' + name);
    } catch (e) {
        failed++;
        console.error('  FAIL  ' + name + ' -> ' + e.message);
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(msg + '（实际=' + JSON.stringify(actual) + '，期望=' + JSON.stringify(expected) + '）');
    }
}
function resetEnv() {
    Object.keys(attrs).forEach(k => delete attrs[k]);
    // 注意：不清理 createdElements —— theme.js 内部缓存了 <style> 节点，跨用例复用
    global.localStorage.clear();
}

// 查找 theme.js 注入的 <style id="cika-custom-theme-style">
function injectedStyle() {
    for (let i = createdElements.length - 1; i >= 0; i--) {
        const el = createdElements[i];
        if (el.tagName === 'style' && el.id === 'cika-custom-theme-style') return el;
    }
    return null;
}

function sampleTheme(id, name, extra) {
    const t = {
        type: '#theme#', app: 'com.cika.chatapp', version: 1,
        id: id, name: name, base: 'dark', description: '测试主题',
        variables: { '--md-primary': '#00BCD4', '--md-background': '#0B1B2A' }
    };
    return Object.assign(t, extra || {});
}

console.log('CikaChat 主题系统单元测试\n');

/* ---------- 内置主题与状态管理 ---------- */
test('内置主题激活写入 data-theme 属性', () => {
    resetEnv();
    ThemeManager.activate('dark');
    assertEq(attrs['data-theme'], 'dark', 'data-theme 应为 dark');
    assert(!attrs['data-custom-theme'], '内置主题不应写入 data-custom-theme');
    assertEq(ThemeManager.getActiveThemeId(), 'dark', '激活主题 id');
    ThemeManager.activate('light');
    assertEq(attrs['data-theme'], 'light', '切换为 light');
    assert(!ThemeManager.isCustomThemeActive(), '内置主题非自定义状态');
});

test('list() 返回内置主题与预览色', () => {
    resetEnv();
    const list = ThemeManager.list();
    assertEq(list.length, 2, '默认仅有内置主题');
    assertEq(list[0].id, 'dark', '第一项为暗黑');
    assert(list[0].builtin && list[0].preview.primary, '内置主题带预览色');
});

/* ---------- 导入校验 ---------- */
test('合法主题导入成功', () => {
    resetEnv();
    const res = ThemeManager.importTheme(sampleTheme('ocean', '海洋'));
    assert(res.ok, '导入应成功');
    assertEq(res.theme.name, '海洋', '主题名');
    assert(ThemeManager.getTheme('ocean'), '可从状态中读取');
});

test('非法主题被拒绝', () => {
    resetEnv();
    assert(!ThemeManager.importTheme({}).ok, '空对象应拒绝');
    assert(!ThemeManager.importTheme({ type: '#theme#', id: 'x', name: 'x', base: 'dark', variables: { color: '#fff' } }).ok,
        '非白名单变量名应拒绝');
    assert(!ThemeManager.importTheme({ type: 'other', id: 'x', name: 'x', base: 'dark', variables: { '--md-primary': '#fff' } }).ok,
        '错误 type 应拒绝');
    assert(!ThemeManager.importTheme({ type: '#theme#', id: 'dark', name: 'x', base: 'dark', variables: { '--md-primary': '#fff' } }).ok,
        '与内置主题 id 冲突应拒绝');
    assert(!ThemeManager.importTheme({ type: '#theme#', id: 'x', name: '', base: 'dark', variables: { '--md-primary': '#fff' } }).ok,
        '空名称应拒绝');
    assert(!ThemeManager.importTheme({ type: '#theme#', id: 'x', name: 'x', base: 'dark', variables: { '--md-primary': 123 } }).ok,
        '变量值非字符串应拒绝');
});

test('id 冲突自动追加后缀', () => {
    resetEnv();
    assert(ThemeManager.importTheme(sampleTheme('dupe', 'A')).ok, '首次导入');
    const r2 = ThemeManager.importTheme(sampleTheme('dupe', 'B'));
    assert(r2.ok, '冲突 id 仍可导入');
    assertEq(r2.theme.id, 'dupe-2', '自动追加 -2 后缀');
});

/* ---------- 样式注入（样式加载逻辑） ---------- */
test('自定义主题激活后注入样式与属性', () => {
    resetEnv();
    ThemeManager.importTheme(sampleTheme('ocean', '海洋'));
    assert(ThemeManager.activate('ocean'), '激活成功');
    assertEq(attrs['data-theme'], 'dark', 'base=dark 时 data-theme 为 dark');
    assertEq(attrs['data-custom-theme'], 'ocean', '写入 data-custom-theme 标记');
    assert(ThemeManager.isCustomThemeActive(), 'isCustomThemeActive 为真');
    const style = injectedStyle();
    assert(style, '<style> 节点已注入');
    assertEq(style.textContent.indexOf('html[data-custom-theme]'), 0, '注入 CSS 选择器正确');
    assert(style.textContent.indexOf('--md-primary: #00BCD4;') >= 0, '主色变量写入样式');
    assert(style.textContent.indexOf('--md-background: #0B1B2A;') >= 0, '背景变量写入样式');
});

test('内置主题激活时清空注入样式', () => {
    resetEnv();
    ThemeManager.importTheme(sampleTheme('ocean', '海洋'));
    ThemeManager.activate('ocean');
    assert(attrs['data-custom-theme'], '先激活自定义主题');
    ThemeManager.activate('light');
    assert(!attrs['data-custom-theme'], '切回内置后清除标记');
    assert(!ThemeManager.isCustomThemeActive(), '自定义状态解除');
    const style = injectedStyle();
    assert(style, '<style> 节点保留');
    assertEq(style.textContent, '', '内置主题时注入样式清空');
});

/* ---------- 持久化与重启恢复 ---------- */
test('预览不持久化，应用后持久化', () => {
    resetEnv();
    ThemeManager.importTheme(sampleTheme('ocean', '海洋'));
    ThemeManager.activate('dark');
    const before = storageMap[ThemeManager.STORAGE_KEY];
    ThemeManager.preview('ocean');
    assertEq(attrs['data-custom-theme'], 'ocean', '预览已应用到页面');
    assertEq(storageMap[ThemeManager.STORAGE_KEY], before, '预览不写入存储');
    ThemeManager.preview('dark');
    assert(!attrs['data-custom-theme'], '预览回退');
    ThemeManager.activate('ocean');
    const saved = JSON.parse(storageMap[ThemeManager.STORAGE_KEY]);
    assertEq(saved.activeThemeId, 'ocean', '存储记录激活主题');
    assert(saved.themes.some(t => t.id === 'ocean'), '存储自定义主题配置');
});

test('重启后自动恢复上次主题', () => {
    resetEnv();
    ThemeManager.importTheme(sampleTheme('ocean', '海洋'));
    ThemeManager.activate('ocean');
    // 模拟重启：清空内存 DOM 状态后重新 init
    Object.keys(attrs).forEach(k => delete attrs[k]);
    ThemeManager.init();
    assertEq(attrs['data-custom-theme'], 'ocean', '重启后恢复自定义主题');
    assertEq(ThemeManager.getActiveThemeId(), 'ocean', '激活状态恢复');
});

/* ---------- 删除与回退 ---------- */
test('删除当前使用的主题自动回退暗黑', () => {
    resetEnv();
    ThemeManager.importTheme(sampleTheme('ocean', '海洋'));
    ThemeManager.activate('ocean');
    assert(ThemeManager.removeTheme('ocean'), '删除成功');
    assertEq(attrs['data-theme'], 'dark', '回退到暗黑');
    assert(!attrs['data-custom-theme'], '无自定义标记');
    assert(!ThemeManager.getTheme('ocean'), '主题已移除');
    assert(!ThemeManager.removeTheme('ocean'), '重复删除返回 false');
});

test('删除非激活主题不影响当前主题', () => {
    resetEnv();
    ThemeManager.importTheme(sampleTheme('a', 'A'));
    ThemeManager.importTheme(sampleTheme('b', 'B'));
    ThemeManager.activate('a');
    ThemeManager.removeTheme('b');
    assertEq(ThemeManager.getActiveThemeId(), 'a', '当前主题不受影响');
});

/* ---------- 激活兜底与 onChange ---------- */
test('激活不存在的主题回退暗黑', () => {
    resetEnv();
    ThemeManager.activate('not-exist');
    assertEq(attrs['data-theme'], 'dark', '回退 dark');
});

test('onChange 回调在正式生效时触发', () => {
    resetEnv();
    let fired = 0;
    ThemeManager.onChange = function () { fired++; };
    ThemeManager.activate('light');
    assertEq(fired, 1, 'activate 触发一次');
    ThemeManager.preview('dark');
    assertEq(fired, 1, '预览不触发回调');
    ThemeManager.onChange = null;
});

/* ---------- 主题样板 ---------- */
test('主题样板可生成且可导入', () => {
    resetEnv();
    const s = ThemeManager.buildThemeFileSample();
    assertEq(s.type, '#theme#', '样板 type 正确');
    assert(s.variables['--md-primary'], '样板含主色变量');
    const res = ThemeManager.importTheme(s);
    assert(res.ok, '样板可正常导入');
});

/* ============================================================ */
console.log('\n结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exitCode = failed > 0 ? 1 : 0;
