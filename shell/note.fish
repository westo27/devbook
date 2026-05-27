function note --description 'Append a timestamped note to today\'s work-notes file'
    set -l dir ~/Documents/work-notes/daily
    set -l today (date +%Y-%m-%d)
    set -l file $dir/$today.md

    if test (count $argv) -eq 0
        echo "Usage: note <text>"
        return 1
    end

    if not test -d $dir
        mkdir -p $dir
    end

    if not test -e $file
        printf '# %s\n\n' $today >$file
    end

    echo "- "(date +%H:%M)" — $argv" >>$file
    echo "Noted in $file"
end
