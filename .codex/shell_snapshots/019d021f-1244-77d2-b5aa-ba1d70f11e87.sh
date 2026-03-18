# Snapshot file
# Unset all aliases to avoid conflicts with functions
# Functions
__zoxide_cd () 
{ 
    \builtin cd -- "$@"
}
__zoxide_doctor () 
{ 
    [[ ${_ZO_DOCTOR:-1} -eq 0 ]] && return 0;
    [[ ${PROMPT_COMMAND[@]:-} == *'__zoxide_hook'* ]] && return 0;
    [[ ${__vsc_original_prompt_command[@]:-} == *'__zoxide_hook'* ]] && return 0;
    _ZO_DOCTOR=0;
    \builtin printf '%s\n' 'zoxide: detected a possible configuration issue.' 'Please ensure that zoxide is initialized right at the end of your shell configuration file (usually ~/.bashrc).' '' 'If the issue persists, consider filing an issue at:' 'https://github.com/ajeetdsouza/zoxide/issues' '' 'Disable this message by setting _ZO_DOCTOR=0.' '' 1>&2
}
__zoxide_hook () 
{ 
    \builtin local -r retval="$?";
    \builtin local pwd_tmp;
    pwd_tmp="$(__zoxide_pwd)";
    if [[ ${__zoxide_oldpwd} != "${pwd_tmp}" ]]; then
        __zoxide_oldpwd="${pwd_tmp}";
        \command zoxide add -- "${__zoxide_oldpwd}";
    fi;
    return "${retval}"
}
__zoxide_pwd () 
{ 
    \builtin pwd -L
}
__zoxide_z () 
{ 
    __zoxide_doctor;
    if [[ $# -eq 0 ]]; then
        __zoxide_cd ~;
    else
        if [[ $# -eq 1 && $1 == '-' ]]; then
            __zoxide_cd "${OLDPWD}";
        else
            if [[ $# -eq 1 && -d $1 ]]; then
                __zoxide_cd "$1";
            else
                if [[ $# -eq 2 && $1 == '--' ]]; then
                    __zoxide_cd "$2";
                else
                    if [[ ${@: -1} == "${__zoxide_z_prefix}"?* ]]; then
                        \builtin local result="${@: -1}";
                        __zoxide_cd "${result:${#__zoxide_z_prefix}}";
                    else
                        \builtin local result;
                        result="$(\command zoxide query --exclude "$(__zoxide_pwd)" -- "$@")" && __zoxide_cd "${result}";
                    fi;
                fi;
            fi;
        fi;
    fi
}
__zoxide_zi () 
{ 
    __zoxide_doctor;
    \builtin local result;
    result="$(\command zoxide query --interactive -- "$@")" && __zoxide_cd "${result}"
}
z () 
{ 
    __zoxide_z "$@"
}
zi () 
{ 
    __zoxide_zi "$@"
}

# setopts 3
set -o braceexpand
set -o hashall
set -o interactive-comments

# aliases 0

# exports 168
declare -x AR="ar"
declare -x AS="as"
declare -x BORG_REPO="u309918@u309918.your-storagebox.de:/home/backups"
declare -x CC="gcc"
declare -x CODEX_HOME="/per/dev/shell-ws/.codex"
declare -x CODEX_MANAGED_BY_NPM="1"
declare -x COLOR="1"
declare -x COLORTERM="truecolor"
declare -x CONFIG_SHELL="/nix/store/j8645yndikbrvn292zgvyv64xrrmwdcb-bash-5.3p3/bin/bash"
declare -x CUPS_DATADIR="/nix/store/vaqjclrc3wc32jq1s1nkj13dbcgba20b-cups-progs/share/cups"
declare -x CXX="g++"
declare -x DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus"
declare -x DESKTOP_SESSION="none+xmonad"
declare -x DISPLAY=":0"
declare -x EDITOR="kak"
declare -x GDMSESSION="none+xmonad"
declare -x GIO_EXTRA_MODULES="/nix/store/9k8518afw7bwmhyjs1pjnawkqi39i21h-dconf-0.49.0-lib/lib/gio/modules"
declare -x GTK_A11Y="none"
declare -x GTK_PATH="/home/sock/.nix-profile/lib/gtk-2.0:/home/sock/.nix-profile/lib/gtk-3.0:/home/sock/.nix-profile/lib/gtk-4.0:/nix/profile/lib/gtk-2.0:/nix/profile/lib/gtk-3.0:/nix/profile/lib/gtk-4.0:/home/sock/.local/state/nix/profile/lib/gtk-2.0:/home/sock/.local/state/nix/profile/lib/gtk-3.0:/home/sock/.local/state/nix/profile/lib/gtk-4.0:/etc/profiles/per-user/sock/lib/gtk-2.0:/etc/profiles/per-user/sock/lib/gtk-3.0:/etc/profiles/per-user/sock/lib/gtk-4.0:/nix/var/nix/profiles/default/lib/gtk-2.0:/nix/var/nix/profiles/default/lib/gtk-3.0:/nix/var/nix/profiles/default/lib/gtk-4.0:/run/current-system/sw/lib/gtk-2.0:/run/current-system/sw/lib/gtk-3.0:/run/current-system/sw/lib/gtk-4.0"
declare -x HOME="/home/sock"
declare -x HOST_PATH="/nix/store/4bahd7i1xja2l0iqnq2v0krrqfzy69gl-nodejs-22.21.1-dev/bin:/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/bin:/nix/store/iiishysy5bzkjrawxl4rld1s04qj0k0c-coreutils-9.8/bin:/nix/store/6hcyzg88adcz37hn5pslwb06ck6pnq07-findutils-4.10.0/bin:/nix/store/7ylvy12ylwy8wxya9i2ly8qkhiz7173r-diffutils-3.12/bin:/nix/store/rm3yhwgahfrmshmcrv6cr28x4rz7881s-gnused-4.9/bin:/nix/store/737jwbhw8ji13x9s88z3wpp8pxaqla92-gnugrep-3.12/bin:/nix/store/gh0ijwnyv6csn59yars8z8kxbnd31y8f-gawk-5.3.2/bin:/nix/store/l5ibq1yp8m7jibzgqbmpc46hkcnvv8fq-gnutar-1.35/bin:/nix/store/0hq8fc3ihp7clficpl72lxybfb23qvfc-gzip-1.14/bin:/nix/store/2xq4b1wjl6yklsqs86mf95lg9j8mbxvl-bzip2-1.0.8-bin/bin:/nix/store/bw02qy5hlr6a12p5f2apkk79204n20yh-gnumake-4.4.1/bin:/nix/store/j8645yndikbrvn292zgvyv64xrrmwdcb-bash-5.3p3/bin:/nix/store/mv1hg02434l28cf4vwg4qbrz2h967ms8-patch-2.8/bin:/nix/store/gq3243j1d8y6qgpcrgbbb0vxkbxzs0ix-xz-5.8.1-bin/bin:/nix/store/30k6wlj854gb3rw7ny2rj3fixn8xrx6p-file-5.45/bin"
declare -x INFOPATH="/home/sock/.nix-profile/info:/home/sock/.nix-profile/share/info:/nix/profile/info:/nix/profile/share/info:/home/sock/.local/state/nix/profile/info:/home/sock/.local/state/nix/profile/share/info:/etc/profiles/per-user/sock/info:/etc/profiles/per-user/sock/share/info:/nix/var/nix/profiles/default/info:/nix/var/nix/profiles/default/share/info:/run/current-system/sw/info:/run/current-system/sw/share/info"
declare -x INIT_CWD="/per/dev/shell-ws"
declare -x IN_NIX_SHELL="impure"
declare -x JOURNAL_STREAM="9:1532"
declare -x LANG="en_US.UTF-8"
declare -x LD="ld"
declare -x LESSKEYIN_SYSTEM="/nix/store/finyfxgml4ispiqpdhdhv1rj8r843jx2-lessconfig"
declare -x LESS_TERMCAP_mb=$'\E[01;31m'
declare -x LESS_TERMCAP_md=$'\E[01;31m'
declare -x LESS_TERMCAP_me=$'\E[0m'
declare -x LESS_TERMCAP_se=$'\E[0m'
declare -x LESS_TERMCAP_so=$'\E[01;44;33m'
declare -x LESS_TERMCAP_ue=$'\E[0m'
declare -x LESS_TERMCAP_us=$'\E[01;32m'
declare -x LIBEXEC_PATH="/home/sock/.nix-profile/libexec:/nix/profile/libexec:/home/sock/.local/state/nix/profile/libexec:/etc/profiles/per-user/sock/libexec:/nix/var/nix/profiles/default/libexec:/run/current-system/sw/libexec"
declare -x LOCALE_ARCHIVE="/run/current-system/sw/lib/locale/locale-archive"
declare -x LOCALE_ARCHIVE_2_27="/nix/store/iv6mysgipfmq0ygrrlx4ym9dzajky62n-glibc-locales-2.40-66/lib/locale/locale-archive"
declare -x LOGNAME="sock"
declare -x LS_COLORS="rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:mi=00:su=37;41:sg=30;43:ca=00:tw=30;42:ow=34;42:st=37;44:ex=01;32:*.7z=01;31:*.ace=01;31:*.alz=01;31:*.apk=01;31:*.arc=01;31:*.arj=01;31:*.bz=01;31:*.bz2=01;31:*.cab=01;31:*.cpio=01;31:*.crate=01;31:*.deb=01;31:*.drpm=01;31:*.dwm=01;31:*.dz=01;31:*.ear=01;31:*.egg=01;31:*.esd=01;31:*.gz=01;31:*.jar=01;31:*.lha=01;31:*.lrz=01;31:*.lz=01;31:*.lz4=01;31:*.lzh=01;31:*.lzma=01;31:*.lzo=01;31:*.pyz=01;31:*.rar=01;31:*.rpm=01;31:*.rz=01;31:*.sar=01;31:*.swm=01;31:*.t7z=01;31:*.tar=01;31:*.taz=01;31:*.tbz=01;31:*.tbz2=01;31:*.tgz=01;31:*.tlz=01;31:*.txz=01;31:*.tz=01;31:*.tzo=01;31:*.tzst=01;31:*.udeb=01;31:*.war=01;31:*.whl=01;31:*.wim=01;31:*.xz=01;31:*.z=01;31:*.zip=01;31:*.zoo=01;31:*.zst=01;31:*.avif=01;35:*.jpg=01;35:*.jpeg=01;35:*.jxl=01;35:*.mjpg=01;35:*.mjpeg=01;35:*.gif=01;35:*.bmp=01;35:*.pbm=01;35:*.pgm=01;35:*.ppm=01;35:*.tga=01;35:*.xbm=01;35:*.xpm=01;35:*.tif=01;35:*.tiff=01;35:*.png=01;35:*.svg=01;35:*.svgz=01;35:*.mng=01;35:*.pcx=01;35:*.mov=01;35:*.mpg=01;35:*.mpeg=01;35:*.m2v=01;35:*.mkv=01;35:*.webm=01;35:*.webp=01;35:*.ogm=01;35:*.mp4=01;35:*.m4v=01;35:*.mp4v=01;35:*.vob=01;35:*.qt=01;35:*.nuv=01;35:*.wmv=01;35:*.asf=01;35:*.rm=01;35:*.rmvb=01;35:*.flc=01;35:*.avi=01;35:*.fli=01;35:*.flv=01;35:*.gl=01;35:*.dl=01;35:*.xcf=01;35:*.xwd=01;35:*.yuv=01;35:*.cgm=01;35:*.emf=01;35:*.ogv=01;35:*.ogx=01;35:*.aac=00;36:*.au=00;36:*.flac=00;36:*.m4a=00;36:*.mid=00;36:*.midi=00;36:*.mka=00;36:*.mp3=00;36:*.mpc=00;36:*.ogg=00;36:*.ra=00;36:*.wav=00;36:*.oga=00;36:*.opus=00;36:*.spx=00;36:*.xspf=00;36:*~=00;90:*#=00;90:*.bak=00;90:*.crdownload=00;90:*.dpkg-dist=00;90:*.dpkg-new=00;90:*.dpkg-old=00;90:*.dpkg-tmp=00;90:*.old=00;90:*.orig=00;90:*.part=00;90:*.rej=00;90:*.rpmnew=00;90:*.rpmorig=00;90:*.rpmsave=00;90:*.swp=00;90:*.tmp=00;90:*.ucf-dist=00;90:*.ucf-new=00;90:*.ucf-old=00;90:"
declare -x NIXPKGS_CONFIG="/etc/nix/nixpkgs-config.nix"
declare -x NIX_BINTOOLS="/nix/store/4dh4138m8gbp56kh63j2pwgsfhf5l8v7-binutils-wrapper-2.44"
declare -x NIX_BINTOOLS_WRAPPER_TARGET_HOST_x86_64_unknown_linux_gnu="1"
declare -x NIX_BUILD_CORES="16"
declare -x NIX_BUILD_TOP="/tmp/nix-shell-2020498-1297907973"
declare -x NIX_CC="/nix/store/myvv172x2am72534zgn9wx0qp5amq6a8-gcc-wrapper-14.3.0"
declare -x NIX_CC_WRAPPER_TARGET_HOST_x86_64_unknown_linux_gnu="1"
declare -x NIX_CFLAGS_COMPILE=" -frandom-seed=gx8g9yf5bz -isystem /nix/store/4bahd7i1xja2l0iqnq2v0krrqfzy69gl-nodejs-22.21.1-dev/include -isystem /nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/include -isystem /nix/store/4bahd7i1xja2l0iqnq2v0krrqfzy69gl-nodejs-22.21.1-dev/include -isystem /nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/include"
declare -x NIX_ENFORCE_NO_NATIVE="1"
declare -x NIX_HARDENING_ENABLE="bindnow format fortify fortify3 libcxxhardeningextensive libcxxhardeningfast pic relro stackclashprotection stackprotector strictoverflow zerocallusedregs"
declare -x NIX_LDFLAGS="-rpath /nix/store/gx8g9yf5bzz65ar4pi3c3c142mzdryh0-nix-shell/lib "
declare -x NIX_PATH="nixpkgs=/nix/var/nix/profiles/per-user/root/channels/nixos:nixos-config=/etc/nixos/configuration.nix:/nix/var/nix/profiles/per-user/root/channels:secrets=/per/secrets.nix:secrets=/per/secrets.nix"
declare -x NIX_PROFILES="/nix/var/nix/profiles/default /home/sock/.nix-profile"
declare -x NIX_SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt"
declare -x NIX_STORE="/nix/store"
declare -x NIX_USER_PROFILE_DIR="/nix/var/nix/profiles/per-user/sock"
declare -x NM="nm"
declare -x NODE="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/bin/node"
declare -x NODE_PATH="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/lib/node_modules"
declare -x NO_AT_BRIDGE="1"
declare -x OBJCOPY="objcopy"
declare -x OBJDUMP="objdump"
declare -x PAGER="less"
declare -x PATH="/per/dev/shell-ws/.codex/tmp/arg0/codex-arg0hYeN1Z:/per/dev/shell-ws/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/path:/per/dev/shell-ws/node_modules/.bin:/per/dev/shell-ws/node_modules/.bin:/per/dev/node_modules/.bin:/per/node_modules/.bin:/node_modules/.bin:/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/nix/store/f43k3lffqlz3n864inxz8zf28jvks1q6-bash-interactive-5.3p3/bin:/nix/store/axrdk0z4gwqv9kpql2lgqq42l37m3yd1-patchelf-0.15.2/bin:/nix/store/myvv172x2am72534zgn9wx0qp5amq6a8-gcc-wrapper-14.3.0/bin:/nix/store/m1k4nxs8r0fl0pjxqp5n37vxgms7gdlb-gcc-14.3.0/bin:/nix/store/ijmp8r14ivvzk5r95lwx49bbv089003g-glibc-2.40-66-bin/bin:/nix/store/iiishysy5bzkjrawxl4rld1s04qj0k0c-coreutils-9.8/bin:/nix/store/4dh4138m8gbp56kh63j2pwgsfhf5l8v7-binutils-wrapper-2.44/bin:/nix/store/v9zpzmigqkcjrw1jpf0zjc49y47cm55s-binutils-2.44/bin:/nix/store/4bahd7i1xja2l0iqnq2v0krrqfzy69gl-nodejs-22.21.1-dev/bin:/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/bin:/nix/store/iiishysy5bzkjrawxl4rld1s04qj0k0c-coreutils-9.8/bin:/nix/store/6hcyzg88adcz37hn5pslwb06ck6pnq07-findutils-4.10.0/bin:/nix/store/7ylvy12ylwy8wxya9i2ly8qkhiz7173r-diffutils-3.12/bin:/nix/store/rm3yhwgahfrmshmcrv6cr28x4rz7881s-gnused-4.9/bin:/nix/store/737jwbhw8ji13x9s88z3wpp8pxaqla92-gnugrep-3.12/bin:/nix/store/gh0ijwnyv6csn59yars8z8kxbnd31y8f-gawk-5.3.2/bin:/nix/store/l5ibq1yp8m7jibzgqbmpc46hkcnvv8fq-gnutar-1.35/bin:/nix/store/0hq8fc3ihp7clficpl72lxybfb23qvfc-gzip-1.14/bin:/nix/store/2xq4b1wjl6yklsqs86mf95lg9j8mbxvl-bzip2-1.0.8-bin/bin:/nix/store/bw02qy5hlr6a12p5f2apkk79204n20yh-gnumake-4.4.1/bin:/nix/store/j8645yndikbrvn292zgvyv64xrrmwdcb-bash-5.3p3/bin:/nix/store/mv1hg02434l28cf4vwg4qbrz2h967ms8-patch-2.8/bin:/nix/store/gq3243j1d8y6qgpcrgbbb0vxkbxzs0ix-xz-5.8.1-bin/bin:/nix/store/30k6wlj854gb3rw7ny2rj3fixn8xrx6p-file-5.45/bin:/home/sock/.nix-profile/bin:/home/sock/.nix-profile/bin:/nix/store/4n712p89hszhrylfbkksgkd8jli9w8rm-ghc-9.10.3-with-packages/bin:/nix/store/4736k740a9xpmz1y1c1smy09sj96d1k3-xmobar/bin:/nix/store/f43k3lffqlz3n864inxz8zf28jvks1q6-bash-interactive-5.3p3/bin:/nix/store/iiishysy5bzkjrawxl4rld1s04qj0k0c-coreutils-9.8/bin:/nix/store/0amhqxqvpjhgcg496xllrd7k9rfwjblg-light-1.2.2/bin:/nix/store/airs70v0hv0rj40921wz72zpii7cny59-pulseaudio-17.0/bin:/home/sock/.nix-profile/bin:/run/wrappers/bin:/home/sock/.nix-profile/bin:/nix/profile/bin:/home/sock/.local/state/nix/profile/bin:/etc/profiles/per-user/sock/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin"
declare -x QTWEBKIT_PLUGIN_PATH="/home/sock/.nix-profile/lib/mozilla/plugins/:/nix/profile/lib/mozilla/plugins/:/home/sock/.local/state/nix/profile/lib/mozilla/plugins/:/etc/profiles/per-user/sock/lib/mozilla/plugins/:/nix/var/nix/profiles/default/lib/mozilla/plugins/:/run/current-system/sw/lib/mozilla/plugins/"
declare -x RANLIB="ranlib"
declare -x READELF="readelf"
declare -x SHELL="/nix/store/f43k3lffqlz3n864inxz8zf28jvks1q6-bash-interactive-5.3p3/bin/bash"
declare -x SHLVL="3"
declare -x SIZE="size"
declare -x SOURCE_DATE_EPOCH="315532800"
declare -x SSH_ASKPASS="/nix/store/991nkgayh5jarv1linyhdpz78sfgzkl3-x11-ssh-askpass-1.2.4.1/libexec/x11-ssh-askpass"
declare -x SSH_AUTH_SOCK="/run/user/1000/wezterm/agent.88664"
declare -x STRINGS="strings"
declare -x STRIP="strip"
declare -x TEMP="/tmp/nix-shell-2020498-1297907973"
declare -x TEMPDIR="/tmp/nix-shell-2020498-1297907973"
declare -x TERM="xterm-256color"
declare -x TERMINAL="xterm-256color"
declare -x TERMINFO_DIRS="/home/sock/.nix-profile/share/terminfo:/nix/profile/share/terminfo:/home/sock/.local/state/nix/profile/share/terminfo:/etc/profiles/per-user/sock/share/terminfo:/nix/var/nix/profiles/default/share/terminfo:/run/current-system/sw/share/terminfo"
declare -x TERM_PROGRAM="WezTerm"
declare -x TERM_PROGRAM_VERSION="0-unstable-2025-10-14"
declare -x TMP="/tmp/nix-shell-2020498-1297907973"
declare -x TMPDIR="/tmp/nix-shell-2020498-1297907973"
declare -x TZDIR="/etc/zoneinfo"
declare -x USER="sock"
declare -x VISUAL="kak"
declare -x WEZTERM_CONFIG_DIR="/home/sock/.config/wezterm"
declare -x WEZTERM_CONFIG_FILE="/home/sock/.config/wezterm/wezterm.lua"
declare -x WEZTERM_EXECUTABLE="/nix/store/5hyg6j00wf0qivsdwi53259cdyh4zwpd-wezterm-0-unstable-2025-10-14/bin/wezterm-gui"
declare -x WEZTERM_EXECUTABLE_DIR="/nix/store/5hyg6j00wf0qivsdwi53259cdyh4zwpd-wezterm-0-unstable-2025-10-14/bin"
declare -x WEZTERM_PANE="19"
declare -x WEZTERM_UNIX_SOCKET="/run/user/1000/wezterm/gui-sock-88664"
declare -x XAUTHORITY="/home/sock/.Xauthority"
declare -x XCURSOR_PATH="/home/sock/.nix-profile/share/icons:/usr/share/icons:/usr/share/pixmaps:/home/sock/.nix-profile/share/icons:/home/sock/.icons:/home/sock/.local/share/icons:/home/sock/.nix-profile/share/icons:/home/sock/.nix-profile/share/pixmaps:/nix/profile/share/icons:/nix/profile/share/pixmaps:/home/sock/.local/state/nix/profile/share/icons:/home/sock/.local/state/nix/profile/share/pixmaps:/etc/profiles/per-user/sock/share/icons:/etc/profiles/per-user/sock/share/pixmaps:/nix/var/nix/profiles/default/share/icons:/nix/var/nix/profiles/default/share/pixmaps:/run/current-system/sw/share/icons:/run/current-system/sw/share/pixmaps"
declare -x XCURSOR_SIZE="28"
declare -x XCURSOR_THEME="Posy_Cursor_Black_125_175"
declare -x XDG_CACHE_HOME="/home/sock/.cache"
declare -x XDG_CONFIG_DIRS="/etc/xdg:/home/sock/.nix-profile/etc/xdg:/nix/profile/etc/xdg:/home/sock/.local/state/nix/profile/etc/xdg:/etc/profiles/per-user/sock/etc/xdg:/nix/var/nix/profiles/default/etc/xdg:/run/current-system/sw/etc/xdg"
declare -x XDG_CONFIG_HOME="/home/sock/.config"
declare -x XDG_CURRENT_DESKTOP="none+xmonad"
declare -x XDG_DATA_DIRS="/nix/store/axrdk0z4gwqv9kpql2lgqq42l37m3yd1-patchelf-0.15.2/share:/nix/var/nix/profiles/default/share:/home/sock/.nix-profile/share:/usr/share/ubuntu:/usr/local/share:/usr/share:/var/lib/snapd/desktop:/nix/store/x7k3jqk6rrxg115jl299rzhan2n3hgqk-desktops/share:/home/sock/.nix-profile/share:/nix/profile/share:/home/sock/.local/state/nix/profile/share:/etc/profiles/per-user/sock/share:/nix/var/nix/profiles/default/share:/run/current-system/sw/share:/home/sock/.nix-profile/share:/nix/var/nix/profiles/default/share:/home/sock/.nix-profile/share:/nix/var/nix/profiles/default/share:/home/sock/.nix-profile/share:/nix/var/nix/profiles/default/share"
declare -x XDG_DATA_HOME="/home/sock/.local/share"
declare -x XDG_GREETER_DATA_DIR="/var/lib/lightdm-data/sock"
declare -x XDG_RUNTIME_DIR="/run/user/1000"
declare -x XDG_SEAT="seat0"
declare -x XDG_SEAT_PATH="/org/freedesktop/DisplayManager/Seat0"
declare -x XDG_SESSION_CLASS="user"
declare -x XDG_SESSION_DESKTOP="none+xmonad"
declare -x XDG_SESSION_ID="1"
declare -x XDG_SESSION_PATH="/org/freedesktop/DisplayManager/Session0"
declare -x XDG_SESSION_TYPE="x11"
declare -x XDG_STATE_HOME="/home/sock/.local/state"
declare -x XDG_VTNR="1"
declare -x XMONAD_XMESSAGE="/nix/store/iiishysy5bzkjrawxl4rld1s04qj0k0c-coreutils-9.8/bin/true"
declare -x __ETC_PROFILE_DONE="1"
declare -x __HM_SESS_VARS_SOURCED="1"
declare -x __NIXOS_SET_ENVIRONMENT_DONE="1"
declare -x __structuredAttrs=""
declare -x buildInputs="/nix/store/4bahd7i1xja2l0iqnq2v0krrqfzy69gl-nodejs-22.21.1-dev"
declare -x buildPhase=$'{ echo "------------------------------------------------------------";\n  echo " WARNING: the existence of this path is not guaranteed.";\n  echo " It is an internal implementation detail for pkgs.mkShell.";\n  echo "------------------------------------------------------------";\n  echo;\n  # Record all build inputs as runtime dependencies\n  export;\n} >> "$out"\n'
declare -x builder="/nix/store/j8645yndikbrvn292zgvyv64xrrmwdcb-bash-5.3p3/bin/bash"
declare -x cmakeFlags=""
declare -x configureFlags=""
declare -x depsBuildBuild=""
declare -x depsBuildBuildPropagated=""
declare -x depsBuildTarget=""
declare -x depsBuildTargetPropagated=""
declare -x depsHostHost=""
declare -x depsHostHostPropagated=""
declare -x depsTargetTarget=""
declare -x depsTargetTargetPropagated=""
declare -x doCheck=""
declare -x doInstallCheck=""
declare -x mesonFlags=""
declare -x name="nix-shell"
declare -x nativeBuildInputs=""
declare -x npm_command="exec"
declare -x npm_config_cache="/home/sock/.npm"
declare -x npm_config_global_prefix="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1"
declare -x npm_config_globalconfig="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/etc/npmrc"
declare -x npm_config_init_module="/home/sock/.npm-init.js"
declare -x npm_config_local_prefix="/per/dev/shell-ws"
declare -x npm_config_node_gyp="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
declare -x npm_config_noproxy=""
declare -x npm_config_npm_version="10.9.4"
declare -x npm_config_prefix="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1"
declare -x npm_config_user_agent="npm/10.9.4 node/v22.21.1 linux x64 workspaces/false"
declare -x npm_config_userconfig="/home/sock/.npmrc"
declare -x npm_execpath="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/lib/node_modules/npm/bin/npm-cli.js"
declare -x npm_lifecycle_event="npx"
declare -x npm_lifecycle_script="codex"
declare -x npm_node_execpath="/nix/store/ymxm7yz4gsgnp2r6p92qrscw026094dy-nodejs-22.21.1/bin/node"
declare -x npm_package_json="/per/dev/shell-ws/package.json"
declare -x npm_package_name="live247"
declare -x npm_package_version="1.0.0"
declare -x out="/nix/store/gx8g9yf5bzz65ar4pi3c3c142mzdryh0-nix-shell"
declare -x outputs="out"
declare -x patches=""
declare -x phases="buildPhase"
declare -x preferLocalBuild="1"
declare -x propagatedBuildInputs=""
declare -x propagatedNativeBuildInputs=""
declare -x shell="/nix/store/j8645yndikbrvn292zgvyv64xrrmwdcb-bash-5.3p3/bin/bash"
declare -x shellHook=$'function codex {\n  mkdir -p /per/dev/shell-ws/.codex\n  CODEX_HOME=/per/dev/shell-ws/.codex \\\n    npx codex "$@"\n}\n'
declare -x stdenv="/nix/store/45wimpzmh2rkgagv1r42q9v73cpdfr58-stdenv-linux"
declare -x strictDeps=""
declare -x system="x86_64-linux"
